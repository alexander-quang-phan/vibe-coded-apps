import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { excludeSpecial } from '../lib/special.js';
import { monthBounds } from '../lib/month.js';
import { userTimeZone } from '../lib/userZone.js';
import { monthlyEquivalentLimit } from '../lib/budgetPeriod.js';
import { selectFor, decodeRows, encodeWrite, presentRow } from '../lib/encryptionCodec.js';

const router = Router();

// Phase 9.5 Part A. The column lists the ROUTE cares about, unchanged from before
// the sweep; `selectFor` turns each into the columns the current phase actually
// needs, and `presentRow` turns a stored row back into exactly this shape. At
// ENCRYPTION_PHASE=off (the default) both are the identity function.
const BUDGET_COLUMNS = 'id, category_id, amount_limit, period';
const BUDGET_LIST_COLUMNS = 'id, category_id, amount_limit, period, created_at';
const TX_SPEND_COLUMNS = 'amount, category_id, is_special';
const STATS_COLUMNS = 'special_expenses_enabled, monthly_limit';

const createSchema = z.object({
  categoryId: z.string().uuid(),
  amountLimit: z.number().positive().finite().max(1_000_000_000),
  period: z.enum(['monthly', 'weekly']).default('monthly'),
});

const updateSchema = z.object({
  amountLimit: z.number().positive().finite().max(1_000_000_000).optional(),
  period: z.enum(['monthly', 'weekly']).optional(),
});

// monthBounds now lives in lib/month.js and takes the user's timezone.

// GET /api/budgets — list every budget plus this-month spend per category.
router.get('/', async (req, res, next) => {
  try {
    const { ym, firstISO, nextFirstISO } = monthBounds(await userTimeZone(req.user.id));

    const [budgetsRes, catsRes, txRes, statsRes] = await Promise.all([
      supabase
        .from('budgets')
        .select(selectFor('budgets', BUDGET_LIST_COLUMNS))
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('categories')
        .select(selectFor('categories', 'id, name, icon, color, type'))
        .eq('user_id', req.user.id)
        .eq('type', 'expense'),
      supabase
        .from('transactions')
        .select(selectFor('transactions', TX_SPEND_COLUMNS))
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .gte('date', firstISO)
        .lt('date', nextFirstISO),
      supabase
        .from('user_stats')
        .select(selectFor('user_stats', STATS_COLUMNS))
        .eq('user_id', req.user.id)
        .single(),
    ]);

    for (const r of [budgetsRes, catsRes, txRes, statsRes]) if (r.error) throw r.error;

    // Decode once, here at the boundary. Everything below this line is the same
    // arithmetic it always was, on the same plaintext field names.
    const budgetRows = decodeRows('budgets', req.user.id, budgetsRes.data);
    const catRows = decodeRows('categories', req.user.id, catsRes.data);
    const txRows = decodeRows('transactions', req.user.id, txRes.data);
    const stats = decodeRows('user_stats', req.user.id, [statsRes.data])[0];

    const specialEnabled = !!stats.special_expenses_enabled;
    const countable = excludeSpecial(txRows, specialEnabled);

    const spendByCat = new Map();
    for (const t of countable) {
      spendByCat.set(t.category_id, (spendByCat.get(t.category_id) ?? 0) + Number(t.amount));
    }
    const catsById = new Map(catRows.map((c) => [c.id, c]));

    const budgets = budgetRows.map((b) => {
      const cat = catsById.get(b.category_id);
      const spent = spendByCat.get(b.category_id) ?? 0;
      const limit = Number(b.amount_limit);
      // `spent` is a MONTH of spend, so a weekly limit has to be scaled to the
      // same window before the two can be divided. Without this a £50/week
      // budget read as ~430% used after a normal month. The raw limit and the
      // period are still returned so the UI can say "£50/week".
      const effectiveLimit = monthlyEquivalentLimit(limit, b.period, ym);
      return {
        id: b.id,
        period: b.period,
        limit,
        effectiveLimit,
        spent: Number(spent.toFixed(2)),
        percent: effectiveLimit > 0 ? spent / effectiveLimit : 0,
        category: cat ? { id: cat.id, name: cat.name, icon: cat.icon, color: cat.color } : null,
      };
    });

    // Phase 10 (A5) — the overall monthly budget. Every expense category
    // counts toward it, so `spent` here is the whole month's countable spend,
    // not a per-category slice. Additive key: nothing above changed shape.
    const overallLimit = stats.monthly_limit === null ? null : Number(stats.monthly_limit);
    const totalSpend = [...spendByCat.values()].reduce((sum, v) => sum + v, 0);

    res.json({
      budgets,
      overall: {
        limit: overallLimit,
        spent: Number(totalSpend.toFixed(2)),
        percent: overallLimit && overallLimit > 0 ? totalSpend / overallLimit : 0,
      },
    });
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
      .insert(encodeWrite('budgets', req.user.id, {
        user_id: req.user.id,
        category_id: categoryId,
        amount_limit: amountLimit,
        period,
      }))
      .select(selectFor('budgets', BUDGET_COLUMNS))
      .single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Budget already exists for this category + period' });
      }
      throw error;
    }

    res.status(201).json({ budget: presentRow('budgets', req.user.id, data, BUDGET_COLUMNS) });
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
      .update(encodeWrite('budgets', req.user.id, payload))
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select(selectFor('budgets', BUDGET_COLUMNS))
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Budget not found' });
    res.json({ budget: presentRow('budgets', req.user.id, data, BUDGET_COLUMNS) });
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
