import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';

const router = Router();

const createSchema = z.object({
  categoryId: z.string().uuid(),
  amountLimit: z.number().positive().finite().max(1_000_000_000),
  period: z.enum(['monthly', 'weekly']).default('monthly'),
});

const updateSchema = z.object({
  amountLimit: z.number().positive().finite().max(1_000_000_000).optional(),
  period: z.enum(['monthly', 'weekly']).optional(),
});

function monthBounds(d = new Date()) {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const nextFirst = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { firstISO: first.toISOString().slice(0, 10), nextFirstISO: nextFirst.toISOString().slice(0, 10) };
}

// GET /api/budgets — list every budget plus this-month spend per category.
router.get('/', async (req, res, next) => {
  try {
    const { firstISO, nextFirstISO } = monthBounds();

    const [budgetsRes, catsRes, txRes] = await Promise.all([
      supabase
        .from('budgets')
        .select('id, category_id, amount_limit, period, created_at')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('categories')
        .select('id, name, icon, color, type')
        .eq('user_id', req.user.id)
        .eq('type', 'expense'),
      supabase
        .from('transactions')
        .select('amount, category_id')
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .gte('date', firstISO)
        .lt('date', nextFirstISO),
    ]);

    for (const r of [budgetsRes, catsRes, txRes]) if (r.error) throw r.error;

    const spendByCat = new Map();
    for (const t of txRes.data) {
      spendByCat.set(t.category_id, (spendByCat.get(t.category_id) ?? 0) + Number(t.amount));
    }
    const catsById = new Map(catsRes.data.map((c) => [c.id, c]));

    const budgets = budgetsRes.data.map((b) => {
      const cat = catsById.get(b.category_id);
      const spent = spendByCat.get(b.category_id) ?? 0;
      const limit = Number(b.amount_limit);
      return {
        id: b.id,
        period: b.period,
        limit,
        spent: Number(spent.toFixed(2)),
        percent: limit > 0 ? spent / limit : 0,
        category: cat ? { id: cat.id, name: cat.name, icon: cat.icon, color: cat.color } : null,
      };
    });

    res.json({ budgets });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid budget', details: parsed.error.flatten() });
    }
    const { categoryId, amountLimit, period } = parsed.data;

    const { data: cat, error: catErr } = await supabase
      .from('categories')
      .select('id, type')
      .eq('id', categoryId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    if (cat.type !== 'expense') {
      return res.status(400).json({ error: 'Budgets are only for expense categories' });
    }

    const { data, error } = await supabase
      .from('budgets')
      .insert({
        user_id: req.user.id,
        category_id: categoryId,
        amount_limit: amountLimit,
        period,
      })
      .select('id, category_id, amount_limit, period')
      .single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Budget already exists for this category + period' });
      }
      throw error;
    }

    res.status(201).json({ budget: data });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }
    const payload = {};
    if (parsed.data.amountLimit !== undefined) payload.amount_limit = parsed.data.amountLimit;
    if (parsed.data.period !== undefined) payload.period = parsed.data.period;
    if (Object.keys(payload).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const { data, error } = await supabase
      .from('budgets')
      .update(payload)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, category_id, amount_limit, period')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Budget not found' });
    res.json({ budget: data });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const { error } = await supabase
      .from('budgets')
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
