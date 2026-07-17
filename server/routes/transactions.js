import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { applyLogEvent } from '../lib/gamification.js';
import { parseTransactionText } from '../lib/parser.js';

const router = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const createSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().positive().finite().max(1_000_000_000),
  type: z.enum(['income', 'expense']),
  description: z.string().trim().max(200).optional().nullable(),
  date: isoDate.optional(),
  // Opt-in special expenses (Task 9.2) — gifts/trips/one-offs outside the budget.
  isSpecial: z.boolean().optional(),
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
    const month = /^\d{4}-\d{2}$/.test(req.query.month ?? '') ? req.query.month : null;

    let query = supabase
      .from('transactions')
      .select('id, amount, type, description, date, category_id, is_recurring, is_special, created_at')
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

    const { data: tx, error: txErr } = await supabase
      .from('transactions')
      .insert({
        user_id: req.user.id,
        category_id: categoryId,
        amount,
        type,
        description: description || null,
        date: date || todayISO(),
        is_special: parsed.data.isSpecial ?? false,
      })
      .select('id, amount, type, description, date, category_id, created_at')
      .single();
    if (txErr) throw txErr;

    // Update streak / XP / shields.
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

    res.status(201).json({ transaction: tx, delta });
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
      .select('type')
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

    const effectiveType = parsed.data.type ?? existing.type;
    if (parsed.data.isSpecial && effectiveType === 'income') {
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
      .select('id, amount, type, description, date, category_id, created_at')
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
