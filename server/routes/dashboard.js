import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { titleForLevel, levelProgress } from '../lib/gamification.js';
import { excludeSpecial, sumSpecial } from '../lib/special.js';
import { monthBounds } from '../lib/month.js';
import { userTimeZone } from '../lib/userZone.js';

import { selectFor, decodeRow, decodeRows } from '../lib/encryptionCodec.js';

const router = Router();

// Phase 9.5 Part A. Read-only, and every response field is named explicitly, so
// no `presentRow` is needed — the job is to DECODE before the arithmetic.
//
// `user_stats` is read with `select('*')` and stays that way: `*` returns the
// `_enc` column too, and `decodeRow` fills the plaintext name back in. That
// matters here because line ~161 returns `stats.monthly_limit`, which at phase
// `enc` would otherwise be `undefined` and serialise as NaN.
const DASH_TX_COLUMNS = 'id, amount, type, category_id, date, is_special';
const DASH_CAT_COLUMNS = 'id, name, icon, color, type';
const DASH_BUDGET_COLUMNS = 'id, category_id, amount_limit, period';
const DASH_RECENT_COLUMNS =
  'id, amount, type, description, date, category_id, original_amount, original_currency, fx_rate, created_at';

// monthBounds now lives in lib/month.js and takes the user's timezone.

router.get('/', async (req, res, next) => {
  try {
    const { firstISO, nextFirstISO } = monthBounds(await userTimeZone(req.user.id));

    const [statsResult, txResult, catResult, budgetResult, recentResult] = await Promise.all([
      supabase
        .from('user_stats')
        .select('*')
        .eq('user_id', req.user.id)
        .single(),
      supabase
        .from('transactions')
        .select(selectFor('transactions', DASH_TX_COLUMNS))
        .eq('user_id', req.user.id)
        .gte('date', firstISO)
        .lt('date', nextFirstISO),
      supabase
        .from('categories')
        .select(selectFor('categories', DASH_CAT_COLUMNS))
        .eq('user_id', req.user.id),
      supabase
        .from('budgets')
        .select(selectFor('budgets', DASH_BUDGET_COLUMNS))
        .eq('user_id', req.user.id),
      supabase
        .from('transactions')
        .select(selectFor('transactions', DASH_RECENT_COLUMNS))
        .eq('user_id', req.user.id)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    for (const r of [statsResult, txResult, catResult, budgetResult, recentResult]) {
      if (r.error) throw r.error;
    }

    // Decode once, at the boundary. Everything below is the arithmetic it was.
    const uid = req.user.id;
    const stats = decodeRow('user_stats', uid, statsResult.data);
    const txs = decodeRows('transactions', uid, txResult.data);
    const catRows = decodeRows('categories', uid, catResult.data);
    const budgetRows = decodeRows('budgets', uid, budgetResult.data);
    const recentRows = decodeRows('transactions', uid, recentResult.data);
    const categoriesById = new Map(catRows.map((c) => [c.id, c]));
    const specialEnabled = !!stats.special_expenses_enabled;

    // Hero totals stay honest cash-flow — every transaction counts, special or not.
    let income = 0;
    let expenses = 0;
    for (const t of txs) {
      const amt = Number(t.amount);
      if (t.type === 'income') income += amt;
      else if (t.type === 'expense') expenses += amt;
    }

    // By-category breakdown (donut, top-5, budget alerts) excludes special
    // expenses while the pref is on — the "outside the monthly budget" promise.
    const categoryTotals = new Map();
    let countableExpenses = 0;
    for (const t of excludeSpecial(txs, specialEnabled)) {
      if (t.type !== 'expense') continue;
      categoryTotals.set(t.category_id, (categoryTotals.get(t.category_id) ?? 0) + Number(t.amount));
      countableExpenses += Number(t.amount);
    }

    const categoryBreakdown = Array.from(categoryTotals.entries())
      .map(([categoryId, total]) => {
        const cat = categoriesById.get(categoryId);
        if (!cat) return null;
        return {
          categoryId,
          name: cat.name,
          icon: cat.icon,
          color: cat.color,
          total: Number(total.toFixed(2)),
          // Divided by the SPECIAL-EXCLUDED total, because that is what these
          // slices are. Dividing by `expenses` (which includes special spend)
          // meant the slices summed to less than 100% and the donut showed a
          // phantom gap whenever any special expense existed.
          percentOfExpenses: countableExpenses > 0 ? total / countableExpenses : 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.total - a.total);

    // Budget alerts — only monthly for now, expense categories.
    const budgetAlerts = [];
    for (const b of budgetRows) {
      if (b.period !== 'monthly') continue;
      const spent = categoryTotals.get(b.category_id) ?? 0;
      const limit = Number(b.amount_limit);
      const percent = limit > 0 ? spent / limit : 0;
      if (percent < 0.75) continue;
      const cat = categoriesById.get(b.category_id);
      if (!cat) continue;
      budgetAlerts.push({
        budgetId: b.id,
        categoryId: b.category_id,
        name: cat.name,
        icon: cat.icon,
        color: cat.color,
        limit,
        spent: Number(spent.toFixed(2)),
        percent,
      });
    }
    budgetAlerts.sort((a, b) => b.percent - a.percent);

    const progress = levelProgress(stats.xp_points);

    res.json({
      month: {
        firstDay: firstISO,
        income: Number(income.toFixed(2)),
        expenses: Number(expenses.toFixed(2)),
        balance: Number((income - expenses).toFixed(2)),
        transactionCount: txs.length,
        specialThisMonth: Number(sumSpecial(txs, specialEnabled).toFixed(2)),
      },
      categoryBreakdown,
      budgetAlerts,
      recentTransactions: recentRows.map((t) => {
        const cat = categoriesById.get(t.category_id);
        return {
          id: t.id,
          amount: Number(t.amount),
          type: t.type,
          description: t.description,
          date: t.date,
          // Phase 12 — so the Dashboard's recent list can show "€45.00" under a
          // converted row, the way the Transactions page already does. These
          // were simply never added to the select.
          original_amount: t.original_amount,
          original_currency: t.original_currency,
          fx_rate: t.fx_rate,
          category: cat
            ? { id: cat.id, name: cat.name, icon: cat.icon, color: cat.color }
            : null,
        };
      }),
      stats: {
        currentStreak: stats.current_streak,
        longestStreak: stats.longest_streak,
        shields: stats.shields,
        xpPoints: stats.xp_points,
        level: stats.level,
        title: titleForLevel(stats.level),
        ...progress,
      },
      preferences: {
        currency: stats.currency,
        simpleMode: stats.simple_mode,
        displayName: stats.display_name,
        monthlyLimit: stats.monthly_limit === null ? null : Number(stats.monthly_limit),
        specialExpensesEnabled: stats.special_expenses_enabled,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
