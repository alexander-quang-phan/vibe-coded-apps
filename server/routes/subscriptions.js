import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { detectSubscriptions } from '../lib/subscriptions.js';
import { manualMerchantKey, isTracked } from '../lib/recurrences.js';
import { normaliseMerchant } from '../lib/merchant.js';
import { userTimeZone } from '../lib/userZone.js';
import { dayInZone, addMonths } from '../lib/month.js';
import {
  buildDetectedRow,
  buildManualRow,
  trackedPrototypes,
  suppressDetected,
  summarise,
  categoryShape,
  repeatPrototypes,
  repeatingFor,
} from '../lib/subscriptionRows.js';
import {
  prototypeOf,
  bestPreviewMatch,
  exactNoteConflict,
  sameAsDetected,
  looksLikeSameCharge,
  nameStrength,
  cycleAligned,
  within,
} from '../lib/subscriptionMatch.js';

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
const SUB_TX_COLUMNS = 'id, amount, type, description, date, category_id, recurrence_id, created_at';
const SUB_OVERRIDE_COLUMNS = 'merchant_key, status, display_name, decided_at';
const SUB_OVERRIDE_READ_COLUMNS = 'status, display_name, decided_at';
const SUB_CAT_COLUMNS = 'id, name, icon, color';
// Phase 17: `auto_log` is selected on EVERY recurrence read — isTracked() fails
// closed, so a read without it would treat a tracked row as a Repeat-this one.
const SUB_REC_COLUMNS =
  'id, category_id, type, amount, description, interval, next_run_at, last_run_at, cancelled_at, created_at, auto_log';
const SUB_REC_PATCH_COLUMNS = 'id, amount, cancelled_at';
const TX_ONE_COLUMNS = 'id, amount, type, description, date, category_id, recurrence_id';

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

const patchSchema = z
  .object({
    status: z.enum(['active', 'cancelled', 'dismissed']).optional(),
    displayName: z.string().nullable().optional(),
  })
  .refine((d) => d.status !== undefined || d.displayName !== undefined, {
    message: 'Provide status or displayName',
  });

// Manual rows have no "dismissed" state (the user opted in deliberately —
// cancel is the correct off-ramp) and no displayName rename surface; Repeat-this
// rows gain an amount edit instead (future instances only). Tracked rows (Phase
// 17) do NOT: their amount follows the latest attached charge.
const manualPatchSchema = z
  .object({
    status: z.enum(['active', 'cancelled', 'dismissed']).optional(),
    amount: z.number().positive().finite().max(1_000_000_000).optional(),
  })
  .refine((d) => d.status !== undefined || d.amount !== undefined, {
    message: 'Provide status or amount',
  });

const uuid = z.string().uuid();
const INTERVALS = ['monthly', 'weekly', 'annual'];

const previewQuerySchema = z.object({
  transactionId: uuid,
  // The Edit dialog's CURRENT values, so the preview matches what Alex has typed,
  // not what was last saved. Omitted ones fall back to the stored row.
  description: z.string().max(200).optional(),
  categoryId: uuid.optional(),
  amount: z.coerce.number().positive().finite().max(1_000_000_000).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  interval: z.enum(INTERVALS).optional(),
});
const recentQuerySchema = z.object({ q: z.string().max(100).optional() });
const trackSchema = z.object({
  transactionId: uuid,
  interval: z.enum(INTERVALS),
  includeTransactionIds: z.array(uuid).max(100).optional(),
});
const attachSchema = z.object({ transactionId: uuid, reactivate: z.boolean().optional() });
const detachSchema = z.object({ transactionId: uuid });

function isValidMerchantKey(key) {
  return DESCRIPTION_KEY.test(key) || SYNTHETIC_KEY.test(key) || MANUAL_KEY.test(key);
}

/**
 * Read EVERY row of a query, past PostgREST's silent max-rows cap.
 *
 * Paged by offset, advancing by the number of rows each page ACTUALLY returned
 * (so it is correct whatever the project's cap is), stopping only on an empty page,
 * and de-duplicated by id (a write landing between pages can shift one row). The
 * builder must order by a unique tie-breaker — date, then id.
 */
const PAGE_SIZE = 500;
const MAX_PAGES = 400; // a runaway backstop far beyond any real account
async function readAllPages(buildQuery) {
  const out = [];
  const seen = new Set();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await buildQuery().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) return out;
    for (const row of data) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
    offset += data.length;
  }
  throw new Error('readAllPages: page limit reached');
}

const expenseQuery = (uid) => () => supabase
  .from('transactions')
  .select(selectFor('transactions', SUB_TX_COLUMNS))
  .eq('user_id', uid)
  .eq('type', 'expense')
  .order('date', { ascending: true })
  .order('id', { ascending: true });

/**
 * Everything the subscription views derive from: all expenses (paged), all
 * recurrences, and the tracked ones as matcher prototypes, with each
 * cancellation converted to the user's own day.
 */
async function loadState(uid) {
  const [txRaw, recRes, zone] = await Promise.all([
    readAllPages(expenseQuery(uid)),
    supabase.from('recurrences').select(selectFor('recurrences', SUB_REC_COLUMNS)).eq('user_id', uid),
    userTimeZone(uid),
  ]);
  if (recRes.error) throw recRes.error;
  const txRows = decodeRows('transactions', uid, txRaw);
  const recurrenceRows = decodeRows('recurrences', uid, recRes.data);
  const linkedById = new Map();
  for (const t of txRows) {
    if (!t.recurrence_id) continue;
    const arr = linkedById.get(t.recurrence_id) ?? [];
    arr.push(t);
    linkedById.set(t.recurrence_id, arr);
  }
  const cancelledDayOf = (ts) => dayInZone(zone, new Date(ts));
  const protos = trackedPrototypes(recurrenceRows, linkedById, cancelledDayOf);
  const repeatProtos = repeatPrototypes(recurrenceRows, linkedById);
  return { txRows, recurrenceRows, linkedById, protos, repeatProtos, zone };
}

async function loadCategories(uid) {
  const { data, error } = await supabase
    .from('categories')
    .select(selectFor('categories', SUB_CAT_COLUMNS))
    .eq('user_id', uid);
  if (error) throw error;
  return new Map(decodeRows('categories', uid, data).map((c) => [c.id, c]));
}

async function loadOverrides(uid) {
  const { data, error } = await supabase
    .from('subscription_overrides')
    .select(selectFor('subscription_overrides', SUB_OVERRIDE_COLUMNS))
    .eq('user_id', uid);
  if (error) throw error;
  // Decode before keying the map — after 019 the plaintext column is gone.
  return new Map(decodeRows('subscription_overrides', uid, data).map((o) => [o.merchant_key, o]));
}

/** Enough of a tracked subscription for the client's subscriptionLabel(). */
function subRef(proto, recurrenceRows, catsById) {
  const rec = recurrenceRows.find((r) => r.id === proto.id);
  return {
    merchantKey: manualMerchantKey(proto.id),
    name: rec?.description || null,
    amount: Number(proto.amount),
    cadence: proto.cadence,
    category: categoryShape(catsById.get(proto.category_id)),
    cancelled: !proto.active,
  };
}


/** One expense of this user, decoded, or null. */
async function loadExpense(uid, id) {
  const { data, error } = await supabase
    .from('transactions')
    .select(selectFor('transactions', TX_ONE_COLUMNS))
    .eq('id', id)
    .eq('user_id', uid)
    .maybeSingle();
  if (error) throw error;
  return data ? decodeRow('transactions', uid, data) : null;
}

/** A recurrence of this user (with auto_log, for isTracked), or null. */
async function loadRecurrence(uid, recurrenceId) {
  const { data, error } = await supabase
    .from('recurrences')
    .select('id, auto_log, cancelled_at')
    .eq('id', recurrenceId)
    .eq('user_id', uid)
    .maybeSingle();
  if (error) throw error;
  return data;
}

const candidateShape = (t) => ({
  id: t.id, date: t.date, amount: Number(t.amount), description: t.description ?? null,
});

router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [state, catsById, overridesByKey] = await Promise.all([
      loadState(uid), loadCategories(uid), loadOverrides(uid),
    ]);

    // Linked charges never feed the detector, so a subscription marked by hand (or
    // logged via Repeat this) is never ALSO listed as a detected one.
    const autoInput = state.txRows.filter((t) => !t.recurrence_id);
    // Then hide detected rows that are STRICTLY a tracked subscription — exact
    // marked note only. Anything weaker is shown twice rather than guessed at.
    const detected = suppressDetected(detectSubscriptions(autoInput), state.protos);

    const autoSubscriptions = detected.map((d) => buildDetectedRow(
      d, overridesByKey.get(d.merchantKey), d.categoryId ? catsById.get(d.categoryId) : null,
    ));
    const manualSubscriptions = state.recurrenceRows.map((r) => buildManualRow(
      r, state.linkedById.get(r.id) ?? [], catsById.get(r.category_id),
    ));

    const subscriptions = [...autoSubscriptions, ...manualSubscriptions];
    res.json({ subscriptions, summary: summarise(subscriptions) });
  } catch (err) {
    next(err);
  }
});

// --- Phase 17: marking a subscription yourself --------------------------------
// Registered before the /:merchantKey routes. None of these can award XP.

/**
 * What marking this expense would mean: an existing tracked subscription to add
 * it to (asking match), a detected row it already belongs to (strict), and — once a
 * cadence is chosen — other charges that look like it.
 */
router.get('/track/preview', async (req, res, next) => {
  try {
    const parsed = previewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid preview request', details: parsed.error.flatten() });
    }
    const uid = req.user.id;
    const q = parsed.data;
    const tx = await loadExpense(uid, q.transactionId);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.type !== 'expense') return res.status(400).json({ error: 'Only expenses can be subscriptions' });
    if (tx.recurrence_id) return res.status(409).json({ error: 'Already part of a subscription' });

    const description = q.description !== undefined ? (q.description.trim() || null) : tx.description;
    const expense = {
      id: tx.id,
      type: 'expense',
      recurrence_id: null,
      date: q.date ?? tx.date,
      description,
      category_id: q.categoryId ?? tx.category_id,
      amount: q.amount ?? Number(tx.amount),
    };

    const [state, catsById, overridesByKey] = await Promise.all([
      loadState(uid), loadCategories(uid), loadOverrides(uid),
    ]);

    const best = bestPreviewMatch(expense, state.protos);
    const existing = best
      ? { ...subRef(best.proto, state.recurrenceRows, catsById), kind: best.kind, strength: best.strength }
      : null;
    const rep = repeatingFor(expense, state.repeatProtos);
    const repeating = rep ? subRef(rep, state.recurrenceRows, catsById) : null;

    const autoInput = state.txRows.filter((t) => !t.recurrence_id);
    // The SAME suppression GET applies, so preview can never point Alex at a
    // detected row the Subscriptions page is hiding behind a tracked one.
    const det = suppressDetected(detectSubscriptions(autoInput), state.protos).find((d) =>
      (overridesByKey.get(d.merchantKey)?.status ?? 'active') !== 'dismissed' && sameAsDetected(expense, d));
    const detected = det
      ? {
        merchantKey: det.merchantKey,
        name: overridesByKey.get(det.merchantKey)?.display_name ?? det.name,
        amount: det.amount,
        cadence: det.cadence,
        category: categoryShape(det.categoryId ? catsById.get(det.categoryId) : null),
      }
      : null;

    let likely = [];
    let maybe = [];
    if (q.interval) {
      // The expense as a one-charge subscription, for "other charges like this one".
      const self = prototypeOf(
        { id: null, description: expense.description, category_id: expense.category_id, amount: expense.amount, interval: q.interval },
        [{ date: expense.date, amount: expense.amount, description: expense.description }],
      );
      const others = autoInput
        .filter((t) => t.id !== expense.id && looksLikeSameCharge(t, self))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      for (const t of others) {
        // Pre-ticked only when it is clearly the same thing: same note, a similar
        // amount, and a whole cycle away. A cycle-aligned £999 "Apple" purchase is
        // offered (unticked), never pre-ticked into an iCloud subscription.
        const exact = nameStrength(normaliseMerchant(t.description), self) === 'exact';
        if (exact && within(t.amount, expense.amount, 0.30) && cycleAligned(t.date, expense.date, q.interval)) {
          likely.push(t);
        } else maybe.push(t);
      }
      likely = likely.slice(0, 24);
      maybe = maybe.slice(0, Math.max(0, 24 - likely.length));
    }

    res.json({
      needsCategory: !expense.category_id,
      existing,
      repeating,
      detected,
      likely: likely.map(candidateShape),
      maybe: maybe.map(candidateShape),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Unlinked expenses from the last 13 months, for "Add a subscription".
 * Read by DATE window (paged), decoded, filtered, THEN cut to 200 — limiting first
 * and filtering second finds nothing for an old yearly charge.
 */
router.get('/track/recent', async (req, res, next) => {
  try {
    const parsed = recentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid search', details: parsed.error.flatten() });
    }
    const uid = req.user.id;
    const zone = await userTimeZone(uid);
    const since = `${addMonths(dayInZone(zone).slice(0, 7), -13)}-01`;
    const [raw, catsById] = await Promise.all([
      readAllPages(() => supabase
        .from('transactions')
        .select(selectFor('transactions', SUB_TX_COLUMNS))
        .eq('user_id', uid)
        .eq('type', 'expense')
        .is('recurrence_id', null)
        .gte('date', since)
        .order('date', { ascending: false })
        .order('id', { ascending: false })),
      loadCategories(uid),
    ]);
    const needle = (parsed.data.q ?? '').trim().toLowerCase();
    const rows = decodeRows('transactions', uid, raw)
      .filter((t) => {
        if (!needle) return true;
        const desc = (t.description ?? '').toLowerCase();
        const cat = (catsById.get(t.category_id)?.name ?? '').toLowerCase();
        return desc.includes(needle) || cat.includes(needle);
      })
      .slice(0, 200)
      .map((t) => ({ ...candidateShape(t), categoryId: t.category_id ?? null }));
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

/** Mark an expense (plus chosen earlier/later charges) as a tracked subscription. */
router.post('/track', async (req, res, next) => {
  try {
    const parsed = trackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid subscription', details: parsed.error.flatten() });
    }
    const uid = req.user.id;
    const { transactionId, interval, includeTransactionIds = [] } = parsed.data;
    const tx = await loadExpense(uid, transactionId);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.type !== 'expense') return res.status(400).json({ error: 'Only expenses can be subscriptions' });
    if (!tx.category_id) return res.status(400).json({ error: 'Give this expense a category first' });
    if (tx.recurrence_id) return res.status(409).json({ error: 'Already part of a subscription' });

    // Same note as a subscription already tracked (any amount, active or
    // cancelled) is the SAME subscription: offer it instead of making a second.
    const [state, catsById] = await Promise.all([loadState(uid), loadCategories(uid)]);
    const rep = repeatingFor(tx, state.repeatProtos);
    if (rep) {
      return res.status(409).json({
        error: 'Trim already logs this automatically — manage it on Subscriptions',
        repeating: subRef(rep, state.recurrenceRows, catsById),
      });
    }
    const conflict = exactNoteConflict(tx, state.protos);
    if (conflict) {
      return res.status(409).json({
        error: 'You already track this subscription',
        existing: { ...subRef(conflict.proto, state.recurrenceRows, catsById), kind: conflict.kind, strength: 'exact' },
      });
    }

    const { data: rec, error: recErr } = await supabase
      .from('recurrences')
      .insert(encodeWrite('recurrences', uid, {
        user_id: uid,
        category_id: tx.category_id,
        type: 'expense',
        // Only a fallback: a tracked row's amount is derived from its charges.
        amount: Number(tx.amount),
        description: tx.description || null,
        interval,
        next_run_at: null,
        auto_log: false,
      }))
      .select('id, created_at')
      .single();
    if (recErr) throw recErr;

    /** Undo everything this request did: unlink first, then delete. Best effort. */
    const rollback = async (linkedIds) => {
      if (linkedIds.length) {
        const { error: unlinkErr } = await supabase
          .from('transactions')
          .update(encodeWrite('transactions', uid, { recurrence_id: null }))
          .in('id', linkedIds)
          .eq('user_id', uid)
          .eq('recurrence_id', rec.id);
        if (unlinkErr) console.error('[subscriptions:track] rollback unlink failed', { userId: uid, recurrenceId: rec.id, message: unlinkErr.message });
      }
      const { error: delErr } = await supabase.from('recurrences').delete().eq('id', rec.id).eq('user_id', uid);
      if (delErr) console.error('[subscriptions:track] rollback delete failed', { userId: uid, recurrenceId: rec.id, message: delErr.message });
    };

    const ids = [...new Set([transactionId, ...includeTransactionIds])];
    // One conditional update. Ids that are not this user's, are income, or are
    // already linked are simply not matched — and the rows it DID link come back.
    const { data: linked, error: linkErr } = await supabase
      .from('transactions')
      .update(encodeWrite('transactions', uid, { recurrence_id: rec.id }))
      .in('id', ids)
      .eq('user_id', uid)
      .eq('type', 'expense')
      .is('recurrence_id', null)
      .select('id');
    if (linkErr || !(linked ?? []).some((r) => r.id === transactionId)) {
      // A double submit or a race: never leave an orphan subscription behind.
      await rollback((linked ?? []).map((r) => r.id));
      if (linkErr) throw linkErr;
      return res.status(409).json({ error: 'That expense was just linked to a subscription — refresh and try again' });
    }

    // Two requests for DIFFERENT expenses with the same note can both pass the
    // duplicate check above before either inserts. Re-check now: if a tracked
    // subscription with the same note was created before this one, it wins and
    // this request undoes itself.
    const key = normaliseMerchant(tx.description);
    if (key) {
      const { data: others, error: othersErr } = await supabase
        .from('recurrences')
        .select(selectFor('recurrences', SUB_REC_COLUMNS))
        .eq('user_id', uid)
        .eq('auto_log', false);
      if (othersErr) {
        // Never leave a possibly-duplicate subscription behind on an unverifiable check.
        await rollback(linked.map((r) => r.id));
        throw othersErr;
      }
      const earlier = decodeRows('recurrences', uid, others ?? []).find((r) => r.id !== rec.id
        && normaliseMerchant(r.description) === key
        && ((r.created_at ?? '') < (rec.created_at ?? '') || ((r.created_at ?? '') === (rec.created_at ?? '') && r.id < rec.id)));
      if (earlier) {
        await rollback(linked.map((r) => r.id));
        return res.status(409).json({
          error: 'You already track this subscription',
          existing: {
            merchantKey: manualMerchantKey(earlier.id),
            name: earlier.description || null,
            amount: Number(earlier.amount),
            cadence: earlier.interval,
            category: categoryShape(catsById.get(earlier.category_id)),
            kind: earlier.cancelled_at ? 'finalOrBack' : 'attach',
            strength: 'exact',
          },
        });
      }
    }

    console.log('[subscriptions:track]', { userId: uid, recurrenceId: rec.id, linked: linked.length });
    res.status(201).json({ subscription: { merchantKey: manualMerchantKey(rec.id), linkedCount: linked.length } });
  } catch (err) {
    next(err);
  }
});

/** Resolve a manual key to this user's TRACKED recurrence, or send the error. */
async function trackedFromKey(req, res) {
  const merchantKey = decodeURIComponent(req.params.merchantKey);
  if (!MANUAL_KEY.test(merchantKey)) {
    res.status(400).json({ error: 'Only subscriptions you marked can be changed here' });
    return null;
  }
  const rec = await loadRecurrence(req.user.id, merchantKey.slice('manual:'.length));
  if (!rec) {
    res.status(404).json({ error: 'Subscription not found' });
    return null;
  }
  if (!isTracked(rec)) {
    res.status(400).json({ error: "Repeat-this schedules aren't changed by hand — cancel it instead" });
    return null;
  }
  return rec;
}

router.post('/:merchantKey/attach', async (req, res, next) => {
  try {
    const parsed = attachSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    const rec = await trackedFromKey(req, res);
    if (!rec) return;
    const uid = req.user.id;
    const { data, error } = await supabase
      .from('transactions')
      .update(encodeWrite('transactions', uid, { recurrence_id: rec.id }))
      .eq('id', parsed.data.transactionId)
      .eq('user_id', uid)
      .eq('type', 'expense')
      .is('recurrence_id', null)
      .select('id');
    if (error) throw error;
    if (!data?.length) {
      return res.status(409).json({ error: "That expense can't be added — it may already be part of a subscription" });
    }
    if (parsed.data.reactivate && rec.cancelled_at) {
      const { error: reErr } = await supabase
        .from('recurrences')
        .update({ cancelled_at: null })
        .eq('id', rec.id)
        .eq('user_id', uid);
      if (reErr) throw reErr;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:merchantKey/detach', async (req, res, next) => {
  try {
    const parsed = detachSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    const rec = await trackedFromKey(req, res);
    if (!rec) return;
    const uid = req.user.id;
    const { data, error } = await supabase
      .from('transactions')
      .update(encodeWrite('transactions', uid, { recurrence_id: null }))
      .eq('id', parsed.data.transactionId)
      .eq('user_id', uid)
      .eq('recurrence_id', rec.id)
      .select('id');
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: "That expense isn't part of this subscription" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Remove a subscription Alex marked by mistake. Its transactions stay, unlinked. */
router.delete('/:merchantKey', async (req, res, next) => {
  try {
    const rec = await trackedFromKey(req, res);
    if (!rec) return;
    const uid = req.user.id;
    // The FK's ON DELETE SET NULL does this in Postgres; doing it explicitly keeps
    // the behaviour identical in the test harness, which has no foreign keys.
    const { error: unlinkErr } = await supabase
      .from('transactions')
      .update(encodeWrite('transactions', uid, { recurrence_id: null }))
      .eq('user_id', uid)
      .eq('recurrence_id', rec.id);
    if (unlinkErr) throw unlinkErr;
    const { error } = await supabase.from('recurrences').delete().eq('id', rec.id).eq('user_id', uid);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Task 6.12a — manual rows dispatch here instead of subscription_overrides.
// Supports cancel/uncancel (toggle recurrences.cancelled_at) and, for Repeat-this
// rows only, an amount edit (future instances only — past transactions already
// have their own amount baked in and are never rewritten).
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
    .select('id, auto_log')
    .eq('id', recurrenceId)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) return res.status(404).json({ error: 'Recurrence not found' });
  if (parsed.data.amount !== undefined && isTracked(existing)) {
    return res
      .status(400)
      .json({ error: "A subscription you marked follows your latest charge — its amount can't be edited." });
  }

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
