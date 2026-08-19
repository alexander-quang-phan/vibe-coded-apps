import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { detectSubscriptions } from '../lib/subscriptions.js';
import { manualMerchantKey } from '../lib/recurrences.js';

import { selectFor, decodeRow, decodeRows, encodeWrite } from '../lib/encryptionCodec.js';
import { CURRENT_PHASE, writesPlaintext } from '../lib/encryptionPhase.js';
import { blindIndex } from '../lib/crypto.js';

const router = Router();

// Phase 9.5 Part A — the one route the codec alone cannot finish.
//
// `subscription_overrides.merchant_key` is not just encrypted, it is the table's
// PRIMARY KEY, and migration 019 moves that key onto `merchant_key_hmac`. So both
// the equality lookup and the upsert's conflict target have to follow the phase:
// the plaintext column while it exists, the blind index once it does not.
// `encodeWrite` fills in `merchant_key_hmac` automatically, because the registry
// declares it as an index derived from `merchant_key`.
const SUB_TX_COLUMNS = 'id, amount, type, description, date, category_id, recurrence_id';
const SUB_OVERRIDE_COLUMNS = 'merchant_key, status, display_name, decided_at';
const SUB_OVERRIDE_READ_COLUMNS = 'status, display_name, decided_at';
const SUB_CAT_COLUMNS = 'id, name, icon, color';
const SUB_REC_COLUMNS =
  'id, category_id, type, amount, description, interval, next_run_at, last_run_at, cancelled_at, created_at';
const SUB_REC_PATCH_COLUMNS = 'id, amount, cancelled_at';

/** Match an override by its key: the plaintext column, or its hash after 019. */
function whereMerchantKey(query, userId, merchantKey) {
  return writesPlaintext(CURRENT_PHASE)
    ? query.eq('merchant_key', merchantKey)
    : query.eq('merchant_key_hmac', blindIndex('subscription_overrides.merchant_key_hmac', userId, merchantKey));
}

/** The upsert conflict target follows the primary key that migration 019 installs. */
const MERCHANT_KEY_CONFLICT = writesPlaintext(CURRENT_PHASE)
  ? 'user_id,merchant_key'
  : 'user_id,merchant_key_hmac';

const DESCRIPTION_KEY = /^[a-z0-9 ]{1,100}$/;
const SYNTHETIC_KEY = /^auto:(?:[a-f0-9-]{36}|none):\d+:(?:monthly|annual)$/;
// Task 6.12a — manually-marked recurrences (a separate recurrences row, not
// a detected merchant). Same loose UUID shape as the rest of the codebase's
// id guards (`/^[0-9a-f-]{36}$/i`).
const MANUAL_KEY = /^manual:[0-9a-f-]{36}$/i;
const MAX_DISPLAY_NAME = 40;
const CADENCE_DAYS = { monthly: 30, weekly: 7 };

const patchSchema = z
  .object({
    status: z.enum(['active', 'cancelled', 'dismissed']).optional(),
    displayName: z.string().nullable().optional(),
  })
  .refine((d) => d.status !== undefined || d.displayName !== undefined, {
    message: 'Provide status or displayName',
  });

// Manual rows have no "dismissed" state (the user opted in deliberately —
// cancel is the correct off-ramp) and no displayName rename surface; they
// gain an amount edit instead (future instances only).
const manualPatchSchema = z
  .object({
    status: z.enum(['active', 'cancelled', 'dismissed']).optional(),
    amount: z.number().positive().finite().max(1_000_000_000).optional(),
  })
  .refine((d) => d.status !== undefined || d.amount !== undefined, {
    message: 'Provide status or amount',
  });

function isValidMerchantKey(key) {
  return DESCRIPTION_KEY.test(key) || SYNTHETIC_KEY.test(key) || MANUAL_KEY.test(key);
}

function round2(n) {
  return Number(n.toFixed(2));
}

function catShape(cat) {
  return cat ? { id: cat.id, name: cat.name, icon: cat.icon, color: cat.color } : null;
}

function summarise(subscriptions) {
  const active = subscriptions.filter((s) => s.status === 'active');
  const cancelled = subscriptions.filter((s) => s.status === 'cancelled');
  const dismissed = subscriptions.filter((s) => s.status === 'dismissed');
  const activeMonthly = active.reduce((sum, s) => sum + s.monthlyCost, 0);
  const cancelledMonthly = cancelled.reduce((sum, s) => sum + s.monthlyCost, 0);
  return {
    activeCount: active.length,
    cancelledCount: cancelled.length,
    dismissedCount: dismissed.length,
    activeMonthly: Number(activeMonthly.toFixed(2)),
    activeAnnual: Number((activeMonthly * 12).toFixed(2)),
    cancelledMonthly: Number(cancelledMonthly.toFixed(2)),
    cancelledAnnual: Number((cancelledMonthly * 12).toFixed(2)),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const [txRes, overridesRes, catsRes, recurrencesRes] = await Promise.all([
      supabase
        .from('transactions')
        .select(selectFor('transactions', SUB_TX_COLUMNS))
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .order('date', { ascending: true }),
      supabase
        .from('subscription_overrides')
        .select(selectFor('subscription_overrides', SUB_OVERRIDE_COLUMNS))
        .eq('user_id', req.user.id),
      supabase
        .from('categories')
        .select(selectFor('categories', SUB_CAT_COLUMNS))
        .eq('user_id', req.user.id),
      // Task 6.12a — manually-marked recurrences. Fetch every row (not just
      // active) so cancelled schedules still surface in their own section.
      supabase
        .from('recurrences')
        .select(selectFor('recurrences', SUB_REC_COLUMNS))
        .eq('user_id', req.user.id),
    ]);

    for (const r of [txRes, overridesRes, catsRes, recurrencesRes]) if (r.error) throw r.error;

    // Decode once, at the boundary. `merchant_key` has to be decoded before it can
    // key this map — after 019 the plaintext column is gone entirely.
    const uid = req.user.id;
    const txRows = decodeRows('transactions', uid, txRes.data);
    const overrideRows = decodeRows('subscription_overrides', uid, overridesRes.data);
    const catRows = decodeRows('categories', uid, catsRes.data);
    const recurrenceRows = decodeRows('recurrences', uid, recurrencesRes.data);

    const overridesByKey = new Map(overrideRows.map((o) => [o.merchant_key, o]));
    const catsById = new Map(catRows.map((c) => [c.id, c]));

    // Manually-marked transactions carry a recurrence_id — exclude them from
    // the auto-detector input so, e.g., rent logged via the recurring opt-in
    // never ALSO shows up as a separate detected subscription (Decision #5
    // in the brief: no double-counting).
    const autoInput = txRows.filter((t) => !t.recurrence_id);
    const byRecurrenceId = new Map();
    for (const t of txRows) {
      if (!t.recurrence_id) continue;
      const arr = byRecurrenceId.get(t.recurrence_id) ?? [];
      arr.push(t);
      byRecurrenceId.set(t.recurrence_id, arr);
    }

    const detected = detectSubscriptions(autoInput);
    const autoSubscriptions = detected.map((d) => {
      const override = overridesByKey.get(d.merchantKey);
      return {
        ...d,
        category: catShape(d.categoryId ? catsById.get(d.categoryId) : null),
        status: override?.status ?? 'active',
        displayName: override?.display_name ?? null,
        decidedAt: override?.decided_at ?? null,
        source: 'auto',
      };
    });

    // Same field shape as the detected rows above (merchantKey, name,
    // inferred, cadence, cadenceDays, amount, monthlyCost, annualCost,
    // lastCharged, nextExpected, totalPaid, occurrences, categoryId,
    // category, status, displayName, decidedAt) plus `source: 'manual'` —
    // the client never needs to special-case fields between the two.
    const manualSubscriptions = recurrenceRows.map((r) => {
      const linked = byRecurrenceId.get(r.id) ?? [];
      const amount = Number(r.amount);
      const monthlyCost = round2(r.interval === 'monthly' ? amount : amount * (52 / 12));
      const annualCost = round2(r.interval === 'monthly' ? amount * 12 : amount * 52);
      return {
        merchantKey: manualMerchantKey(r.id),
        name: r.description || null,
        inferred: false,
        cadence: r.interval,
        cadenceDays: CADENCE_DAYS[r.interval],
        amount: round2(amount),
        monthlyCost,
        annualCost,
        lastCharged: linked.length ? linked.map((t) => t.date).sort().at(-1) : null,
        nextExpected: r.next_run_at,
        totalPaid: round2(linked.reduce((sum, t) => sum + Number(t.amount), 0)),
        occurrences: linked.length,
        categoryId: r.category_id,
        category: catShape(catsById.get(r.category_id)),
        status: r.cancelled_at ? 'cancelled' : 'active',
        displayName: null,
        decidedAt: r.cancelled_at ?? null,
        source: 'manual',
      };
    });

    const subscriptions = [...autoSubscriptions, ...manualSubscriptions];
    res.json({ subscriptions, summary: summarise(subscriptions) });
  } catch (err) {
    next(err);
  }
});

// Task 6.12a — manual rows dispatch here instead of subscription_overrides.
// Supports cancel/uncancel (toggle recurrences.cancelled_at) and amount edit
// (future instances only — past transactions already have their own amount
// baked in and are never rewritten).
async function patchManualRecurrence(req, res, merchantKey) {
  const recurrenceId = merchantKey.slice('manual:'.length);

  const parsed = manualPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
  }
  if (parsed.data.status === 'dismissed') {
    return res
      .status(400)
      .json({ error: 'Manually-marked recurrences cannot be dismissed — cancel it instead.' });
  }

  const { data: existing, error: readErr } = await supabase
    .from('recurrences')
    .select('id')
    .eq('id', recurrenceId)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) return res.status(404).json({ error: 'Recurrence not found' });

  const payload = {};
  if (parsed.data.status === 'cancelled') payload.cancelled_at = new Date().toISOString();
  else if (parsed.data.status === 'active') payload.cancelled_at = null;
  if (parsed.data.amount !== undefined) payload.amount = parsed.data.amount;

  const { data, error } = await supabase
    .from('recurrences')
    .update(encodeWrite('recurrences', req.user.id, payload))
    .eq('id', recurrenceId)
    .eq('user_id', req.user.id)
    .select(selectFor('recurrences', SUB_REC_PATCH_COLUMNS))
    .single();
  if (error) throw error;

  const updated = decodeRow('recurrences', req.user.id, data);
  res.json({
    recurrence: {
      merchantKey: manualMerchantKey(updated.id),
      status: updated.cancelled_at ? 'cancelled' : 'active',
      amount: Number(updated.amount),
      cancelledAt: updated.cancelled_at,
    },
  });
}

router.patch('/:merchantKey', async (req, res, next) => {
  try {
    const merchantKey = decodeURIComponent(req.params.merchantKey);
    if (!isValidMerchantKey(merchantKey)) {
      return res.status(400).json({ error: 'Invalid merchant key' });
    }

    if (merchantKey.startsWith('manual:')) {
      return await patchManualRecurrence(req, res, merchantKey);
    }

    // Non-manual keys keep the existing subscription_overrides behaviour
    // exactly (description-grouped or synthetic auto: keys).
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }

    const status = parsed.data.status;
    let displayName = parsed.data.displayName;
    if (typeof displayName === 'string') {
      displayName = displayName.trim();
      if (displayName.length === 0) displayName = null;
      else if (displayName.length > MAX_DISPLAY_NAME) {
        return res
          .status(400)
          .json({ error: `Display name must be ${MAX_DISPLAY_NAME} characters or fewer.` });
      }
    }

    const { data: existingRaw, error: readErr } = await whereMerchantKey(
      supabase
        .from('subscription_overrides')
        .select(selectFor('subscription_overrides', SUB_OVERRIDE_READ_COLUMNS))
        .eq('user_id', req.user.id),
      req.user.id,
      merchantKey,
    ).maybeSingle();
    if (readErr) throw readErr;
    const existing = decodeRow('subscription_overrides', req.user.id, existingRaw);

    const merged = {
      user_id: req.user.id,
      merchant_key: merchantKey,
      status: status ?? existing?.status ?? 'active',
      display_name:
        displayName !== undefined ? displayName : existing?.display_name ?? null,
      decided_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('subscription_overrides')
      .upsert(encodeWrite('subscription_overrides', req.user.id, merged), {
        onConflict: MERCHANT_KEY_CONFLICT,
      })
      .select(selectFor('subscription_overrides', SUB_OVERRIDE_COLUMNS))
      .single();

    if (error) throw error;

    const saved = decodeRow('subscription_overrides', req.user.id, data);
    res.json({
      override: {
        merchantKey: saved.merchant_key,
        status: saved.status,
        displayName: saved.display_name,
        decidedAt: saved.decided_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
