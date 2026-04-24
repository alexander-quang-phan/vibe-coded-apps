import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { titleForLevel, levelProgress } from '../lib/gamification.js';

const router = Router();

function monthBounds(d = new Date()) {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const nextFirst = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return {
    firstISO: first.toISOString().slice(0, 10),
    nextFirstISO: nextFirst.toISOString().slice(0, 10),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { firstISO, nextFirstISO } = monthBounds();

    const [statsResult, txResult, catResult, budgetResult, recentResult] = await Promise.all([
      supabase
        .from('user_stats')
        .select('*')
        .eq('user_id', req.user.id)
        .single(),
      supabase
        .from('transactions')
        .select('id, amount, type, category_id, date')
        .eq('user_id', req.user.id)
        .gte('date', firstISO)
        .lt('date', nextFirstISO),
      supabase
        .from('categories')
        .select('id, name, icon, color, type')
        .eq('user_id', req.user.id),
      supabase
        .from('budgets')
        .select('id, category_id, amount_limit, period')
        .eq('user_id', req.user.id),
      supabase
        .from('transactions')
        .select('id, amount, type, description, date, category_id, created_at')
        .eq('user_id', req.user.id)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    for (const r of [statsResult, txResult, catResult, budgetResult, recentResult]) {
      if (r.error) throw r.error;
    }

    const stats = statsResult.data;
    const txs = txResult.data;
    const categoriesById = new Map(catResult.data.map((c) => [c.id, c]));

    let income = 0;
    let expenses = 0;
    const categoryTotals = new Map();

    for (const t of txs) {
      const amt = Number(t.amount);
      if (t.type === 'income') income += amt;
      else if (t.type === 'expense') {
        expenses += amt;
        categoryTotals.set(t.category_id, (categoryTotals.get(t.category_id) ?? 0) + amt);
      }
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
          percentOfExpenses: expenses > 0 ? total / expenses : 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.total - a.total);

    // Budget alerts — only monthly for now, expense categories.
    const budgetAlerts = [];
    for (const b of budgetResult.data) {
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
      },
      categoryBreakdown,
      budgetAlerts,
      recentTransactions: recentResult.data.map((t) => {
        const cat = categoriesById.get(t.category_id);
        return {
          id: t.id,
          amount: Number(t.amount),
          type: t.type,
          description: t.description,
          date: t.date,
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
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
