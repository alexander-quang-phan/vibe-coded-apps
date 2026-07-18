import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

function ymKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(d) {
  return d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
}

// GET /api/analytics?months=6
// Returns: { series: [{ ym, label, income, expenses, net }],
//            topCategories: [{ categoryId, name, icon, color, total }],
//            mom: { thisMonth, lastMonth, deltaPct } }
router.get('/', async (req, res, next) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);

    const now = new Date();
    const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const startISO = startDate.toISOString().slice(0, 10);
    const endISO = endDate.toISOString().slice(0, 10);

    const [txRes, catsRes, statsRes] = await Promise.all([
      supabase
        .from('transactions')
        .select('amount, type, date, category_id, is_special')
        .eq('user_id', req.user.id)
        .gte('date', startISO)
        .lt('date', endISO),
      supabase
        .from('categories')
        .select('id, name, icon, color, type')
        .eq('user_id', req.user.id),
      supabase
        .from('user_stats')
        .select('special_expenses_enabled')
        .eq('user_id', req.user.id)
        .single(),
    ]);
    if (txRes.error) throw txRes.error;
    if (catsRes.error) throw catsRes.error;
    if (statsRes.error) throw statsRes.error;

    const specialEnabled = !!statsRes.data.special_expenses_enabled;

    // Build empty months series (ascending).
    const series = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + i, 1));
      series.push({ ym: ymKey(d), label: monthLabel(d), income: 0, expenses: 0, net: 0, special: 0 });
    }
    const seriesByYm = new Map(series.map((s) => [s.ym, s]));

    const catsById = new Map(catsRes.data.map((c) => [c.id, c]));

    const thisYm = ymKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    const lastYm = ymKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));

    const catTotalsThisMonth = new Map();

    for (const t of txRes.data) {
      const d = new Date(t.date + 'T00:00:00Z');
      const ym = ymKey(d);
      const bucket = seriesByYm.get(ym);
      if (!bucket) continue;
      const amount = Number(t.amount);
      if (t.type === 'income') bucket.income += amount;
      else bucket.expenses += amount;
      // Expenses only — this query fetches income rows too, and sumSpecial()
      // in lib/special.js applies the same guard.
      if (t.is_special && specialEnabled && t.type !== 'income') bucket.special += amount;

      if (ym === thisYm && t.type === 'expense') {
        catTotalsThisMonth.set(t.category_id, (catTotalsThisMonth.get(t.category_id) ?? 0) + amount);
      }
    }

    for (const s of series) {
      s.income = Number(s.income.toFixed(2));
      s.expenses = Number(s.expenses.toFixed(2));
      s.net = Number((s.income - s.expenses).toFixed(2));
      s.special = Number(s.special.toFixed(2));
    }

    const topCategories = [...catTotalsThisMonth.entries()]
      .map(([categoryId, total]) => {
        const cat = catsById.get(categoryId);
        return {
          categoryId,
          name: cat?.name ?? 'Unknown',
          icon: cat?.icon ?? null,
          color: cat?.color ?? null,
          total: Number(total.toFixed(2)),
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    const thisMonthBucket = seriesByYm.get(thisYm);
    const lastMonthBucket = seriesByYm.get(lastYm);
    const thisMonthExpenses = thisMonthBucket?.expenses ?? 0;
    const lastMonthExpenses = lastMonthBucket?.expenses ?? 0;
    const deltaPct =
      lastMonthExpenses > 0
        ? Number((((thisMonthExpenses - lastMonthExpenses) / lastMonthExpenses) * 100).toFixed(1))
        : null;

    res.json({
      series,
      topCategories,
      mom: {
        thisMonth: thisMonthExpenses,
        lastMonth: lastMonthExpenses,
        deltaPct,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
