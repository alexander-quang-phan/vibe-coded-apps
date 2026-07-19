import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { applyLogEvent } from '../lib/gamification.js';
import { parseTransactionText } from '../lib/parser.js';
import { nextRunDate, manualMerchantKey } from '../lib/recurrences.js';

const router = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

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
  recurring: recurringSchema.optional(),
});

const updateSchema = z.object({
  categoryId: z.string().uuid().optional(),
  amount: z.number().positive().finite().max(1_000_000_000).optional(),
  type: z.enum(['income', 'expense']).optional(),
  description: z.string().trim().max(200).optional().nullable(),
  date: isoDate.optional(),
  isSpecial: z.boolean().optional(),
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
        'id, amount, type, description, date, category_id, is_recurring, is_special, recurrence_id, created_at',
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
        is_recurring: !!recurrence,
        recurrence_id: recurrence?.id ?? null,
      })
      .select(
        'id, amount, type, description, date, category_id, is_special, is_recurring, recurrence_id, created_at',
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
      .select('type, is_special')
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

    const payload = {};
    if (parsed.data.categoryId !== undefined) payload.category_id = parsed.data.categoryId;
    if (parsed.data.amount !== undefined) payload.amount = parsed.data.amount;
    if (parsed.data.type !== undefined) payload.type = parsed.data.type;
    if (parsed.data.description !== undefined) payload.description = parsed.data.description || null;
    if (parsed.data.date !== undefined) payload.date = parsed.data.date;
    if (parsed.data.isSpecial !== undefined) payload.is_special = parsed.data.isSpecial;
    if (Object.keys(payload).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const { data, error } = await supabase
      .from('transactions')
      .update(payload)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, amount, type, description, date, category_id, is_special, created_at')
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
