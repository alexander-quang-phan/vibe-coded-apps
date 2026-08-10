import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { applyLogEvent } from '../lib/gamification.js';
import { parseTransactionText } from '../lib/parser.js';
import { nextRunDate, manualMerchantKey } from '../lib/recurrences.js';

const router = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/**
 * Confirm a client-supplied special-group id belongs to this user before we
 * write it. Every other client-supplied foreign key in the API is checked this
 * way (categories here, reassign_to in routes/categories.js, goal ids in
 * routes/goals.js); this one was not, and the service-role client bypasses RLS,
 * so nothing else would have caught it. Returns true when there is nothing to
 * check (null clears the group, undefined leaves it alone).
 */
async function ownsSpecialGroup(userId, groupId) {
  if (groupId === undefined || groupId === null) return true;
  const { data, error } = await supabase
    .from('special_groups')
    .select('id')
    .eq('id', groupId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// Task 6.12a — opt-in recurring schedule, expense-only (mirrors /subscriptions,
// which is expense-only by design). Weekly/monthly only; see lib/recurrences.js.
const recurringSchema = z.object({
  interval: z.enum(['monthly', 'weekly']),
});

const createSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().positive().finite().max(1_000_000_000),
  type: z.enum(['income', 'expense']),
  description: z.string().trim().max(200).optional().nullable(),
  date: isoDate.optional(),
  // Opt-in special expenses (Task 9.2) — gifts/trips/one-offs outside the budget.
  isSpecial: z.boolean().optional(),
  // Phase 10 B1 — optional grouping for special expenses ("Paris holiday").
  // Null clears it. Only ever valid on a special EXPENSE (guarded below).
  specialGroupId: z.string().uuid().optional().nullable(),
  recurring: recurringSchema.optional(),
});

const updateSchema = z.object({
  categoryId: z.string().uuid().optional(),
  amount: z.number().positive().finite().max(1_000_000_000).optional(),
  type: z.enum(['income', 'expense']).optional(),
  description: z.string().trim().max(200).optional().nullable(),
  date: isoDate.optional(),
  isSpecial: z.boolean().optional(),
  specialGroupId: z.string().uuid().optional().nullable(),
});

const parseSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ?month=YYYY-MM support (Task 9.2, consumed by Task 9.4's monthly history).
function nextMonthFirstISO(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    // Bounded to 01-12 — a bare \d{2} would let "2026-13" reach Postgres as an
    // invalid date literal and surface as a 500 instead of being ignored.
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month ?? '') ? req.query.month : null;

    let query = supabase
      .from('transactions')
      .select(
        'id, amount, type, description, date, category_id, is_recurring, is_special, special_group_id, recurrence_id, created_at',
      )
      .eq('user_id', req.user.id);

    if (month) {
      query = query.gte('date', `${month}-01`).lt('date', nextMonthFirstISO(month));
    }

    const { data, error } = await query
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json({ transactions: data });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid transaction', details: parsed.error.flatten() });
    }
    const { categoryId, amount, type, description, date } = parsed.data;

    // Verify category belongs to this user and matches the requested type.
    const { data: category, error: catErr } = await supabase
      .from('categories')
      .select('id, type')
      .eq('id', categoryId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!category) return res.status(404).json({ error: 'Category not found' });
    if (category.type !== type) {
      return res.status(400).json({ error: 'Category type does not match transaction type' });
    }
    if (parsed.data.isSpecial && type === 'income') {
      return res.status(400).json({ error: 'Only expenses can be special' });
    }
    // Task 6.12a — recurring is expense-only, same reasoning as isSpecial:
    // /subscriptions (the management surface for these) is expense-only.
    if (parsed.data.recurring && type === 'income') {
      return res.status(400).json({ error: 'Only expenses can be recurring' });
    }
    // Phase 10 B1 — a group is a label on special spending. Attaching one to a
    // non-special row would silently drop out of the group's total, which
    // filters on is_special.
    if (parsed.data.specialGroupId && !parsed.data.isSpecial) {
      return res.status(400).json({ error: 'Only special expenses can belong to a group' });
    }
    if (!(await ownsSpecialGroup(req.user.id, parsed.data.specialGroupId))) {
      return res.status(404).json({ error: 'Special group not found' });
    }

    const txDate = date || todayISO();

    // Create the recurrences row FIRST so we have its id to attach to the
    // transaction below. Anchor day-of-month is derived from `txDate` here
    // (this is the ONE moment we know the user's intended day directly);
    // every later advance (lib/runRecurrences.js) re-derives it from this
    // row's `created_at` instead, since the schema has no separate anchor
    // column. Those two match for the normal flow (txDate defaults to
    // "today", same as `created_at`'s date) — a caller that explicitly
    // back/post-dates the opt-in transaction to a different day-of-month
    // than today is a known, documented edge case: the monthly anchor will
    // follow the row's creation day, not the custom txDate.
    let recurrence = null;
    if (parsed.data.recurring) {
      const anchorDay = Number(txDate.slice(8, 10));
      const initialNextRunAt = nextRunDate(txDate, parsed.data.recurring.interval, anchorDay);
      const { data: rec, error: recErr } = await supabase
        .from('recurrences')
        .insert({
          user_id: req.user.id,
          category_id: categoryId,
          type,
          amount,
          description: description || null,
          interval: parsed.data.recurring.interval,
          next_run_at: initialNextRunAt,
        })
        .select('id, category_id, type, amount, description, interval, next_run_at')
        .single();
      if (recErr) throw recErr;
      recurrence = rec;
    }

    const { data: tx, error: txErr } = await supabase
      .from('transactions')
      .insert({
        user_id: req.user.id,
        category_id: categoryId,
        amount,
        type,
        description: description || null,
        date: txDate,
        is_special: parsed.data.isSpecial ?? false,
        // Was missing entirely: the route validated and guarded specialGroupId,
        // then dropped it on the floor. A group picked in Quick Add was silently
        // discarded and the row never showed up under its group — only re-saving
        // via PATCH, which does write the column, appeared to "fix" it. Invisible
        // in dev because scripts/devMock.js persists it correctly.
        special_group_id: parsed.data.specialGroupId ?? null,
        is_recurring: !!recurrence,
        recurrence_id: recurrence?.id ?? null,
      })
      .select(
        'id, amount, type, description, date, category_id, is_special, special_group_id, is_recurring, recurrence_id, created_at',
      )
      .single();
    if (txErr) {
      // The transaction is what the user actually asked to log — if it fails
      // after the recurrence was created, best-effort delete the recurrence
      // so no phantom subscription appears on /subscriptions.
      if (recurrence) {
        await supabase.from('recurrences').delete().eq('id', recurrence.id).eq('user_id', req.user.id);
      }
      throw txErr;
    }

    // Update streak / XP / shields. This is the user's own opt-in log — it
    // still counts, recurring or not. Only CRON-created child transactions
    // (lib/runRecurrences.js) skip this, by Alex's explicit decision.
    const { data: stats, error: statsErr } = await supabase
      .from('user_stats')
      .select('*')
      .eq('user_id', req.user.id)
      .single();
    if (statsErr) throw statsErr;

    const { next: nextStats, delta } = applyLogEvent(stats, todayISO());

    const { error: updErr } = await supabase
      .from('user_stats')
      .update(nextStats)
      .eq('user_id', req.user.id);
    if (updErr) throw updErr;

    console.log('[tx:create]', { userId: req.user.id, txId: tx.id });

    res.status(201).json({
      transaction: tx,
      delta,
      recurrence: recurrence
        ? {
            id: recurrence.id,
            interval: recurrence.interval,
            nextRunAt: recurrence.next_run_at,
            amount: Number(recurrence.amount),
            categoryId: recurrence.category_id,
            merchantKey: manualMerchantKey(recurrence.id),
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// Natural-language parse → returns a draft for QuickAdd to pre-fill. Never writes.
router.post('/parse', async (req, res, next) => {
  try {
    const parsed = parseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    const [{ data: cats, error: catErr }, { data: stats, error: statsErr }] = await Promise.all([
      supabase
        .from('categories')
        .select('id, name, type')
        .eq('user_id', req.user.id),
      supabase
        .from('user_stats')
        .select('currency')
        .eq('user_id', req.user.id)
        .maybeSingle(),
    ]);
    if (catErr) throw catErr;
    if (statsErr) throw statsErr;

    const result = await parseTransactionText({
      text: parsed.data.text,
      categories: cats || [],
      currency: stats?.currency || 'GBP',
      today: todayISO(),
    });

    if (!result.ok) {
      const status = result.reason === 'unavailable' ? 503 : 422;
      return res.status(status).json({ error: 'parse_failed', reason: result.reason });
    }

    res.json({ parsed: result.data });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }

    // Load the existing row to authorise ownership and, for the income guard
    // below, know the current type when the caller isn't also changing it.
    const { data: existing, error: existingErr } = await supabase
      .from('transactions')
      .select('type, is_special, special_group_id')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    // If changing category, confirm it belongs to the user.
    if (parsed.data.categoryId) {
      const { data: category, error: catErr } = await supabase
        .from('categories')
        .select('id, type')
        .eq('id', parsed.data.categoryId)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (catErr) throw catErr;
      if (!category) return res.status(404).json({ error: 'Category not found' });
      if (parsed.data.type && category.type !== parsed.data.type) {
        return res.status(400).json({ error: 'Category type does not match transaction type' });
      }
    }

    // Guard on the RESULTING state, not just this request's fields: flipping an
    // already-special expense to income would otherwise leave a flagged income row.
    const effectiveType = parsed.data.type ?? existing.type;
    const effectiveSpecial = parsed.data.isSpecial ?? existing.is_special;
    if (effectiveSpecial && effectiveType === 'income') {
      return res.status(400).json({ error: 'Only expenses can be special' });
    }
    // Same resulting-state reasoning for groups — but un-starring is a
    // legitimate action that CLEARS the group, not a contradiction to reject.
    // Only an explicit attempt to attach a group to a non-special row is an
    // error. (Rejecting the un-star was a real bug caught in testing: it made
    // grouped transactions impossible to un-star.)
    const clearingSpecial = parsed.data.isSpecial === false;
    const effectiveGroup = clearingSpecial
      ? null
      : parsed.data.specialGroupId !== undefined
        ? parsed.data.specialGroupId
        : existing.special_group_id;
    if (effectiveGroup && !effectiveSpecial) {
      return res.status(400).json({ error: 'Only special expenses can belong to a group' });
    }
    if (!(await ownsSpecialGroup(req.user.id, parsed.data.specialGroupId))) {
      return res.status(404).json({ error: 'Special group not found' });
    }

    const payload = {};
    if (parsed.data.categoryId !== undefined) payload.category_id = parsed.data.categoryId;
    if (parsed.data.amount !== undefined) payload.amount = parsed.data.amount;
    if (parsed.data.type !== undefined) payload.type = parsed.data.type;
    if (parsed.data.description !== undefined) payload.description = parsed.data.description || null;
    if (parsed.data.date !== undefined) payload.date = parsed.data.date;
    if (parsed.data.isSpecial !== undefined) payload.is_special = parsed.data.isSpecial;
    if (parsed.data.specialGroupId !== undefined) payload.special_group_id = parsed.data.specialGroupId;
    // Un-starring clears the group automatically — the guard above already
    // refuses the contradictory combination, this handles the honest one.
    if (parsed.data.isSpecial === false) payload.special_group_id = null;
    if (Object.keys(payload).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const { data, error } = await supabase
      .from('transactions')
      .update(payload)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, amount, type, description, date, category_id, is_special, special_group_id, is_recurring, recurrence_id, created_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ transaction: data });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
