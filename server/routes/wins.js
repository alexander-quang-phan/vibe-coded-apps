import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();
const DAY_MS = 86_400_000;
const WEEKS_PER_MONTH = 4.345;

function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function formatMoney(amount, currency) {
  return new Intl.NumberFormat(currency === 'VND' ? 'vi-VN' : 'en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'VND' ? 0 : 2,
  }).format(amount);
}

function latestDateForCategory(transactions, categoryId, fallback) {
  return transactions
    .filter((t) => t.category_id === categoryId)
    .map((t) => t.date)
    .sort()
    .at(-1) ?? fallback;
}

router.get('/', async (req, res, next) => {
  try {
    const today = startOfUtcDay();
    const weekStart = new Date(today.getTime() - 6 * DAY_MS);
    const eventCutoff = new Date(today.getTime() - 14 * DAY_MS);
    const todayISO = dateOnly(today);
    const weekStartISO = dateOnly(weekStart);

    const [statsRes, txRes, catsRes, budgetsRes, goalsRes, contribsRes] = await Promise.all([
      supabase
        .from('user_stats')
        .select('current_streak, longest_streak, shields, last_logged_date, currency')
        .eq('user_id', req.user.id)
        .single(),
      supabase
        .from('transactions')
        .select('id, amount, type, category_id, date, created_at')
        .eq('user_id', req.user.id)
        .gte('date', weekStartISO)
        .lte('date', todayISO)
        .limit(500),
      supabase
        .from('categories')
        .select('id, name, icon, color, type')
        .eq('user_id', req.user.id),
      supabase
        .from('budgets')
        .select('id, category_id, amount_limit, period')
        .eq('user_id', req.user.id),
      supabase
        .from('savings_goals')
        .select('id, name, emoji, target_amount, current_amount')
        .eq('user_id', req.user.id),
      supabase
        .from('savings_contributions')
        .select('id, goal_id, amount, date, created_at')
        .eq('user_id', req.user.id)
        .gte('created_at', eventCutoff.toISOString())
        .order('created_at', { ascending: false })
        .limit(25),
    ]);

    for (const result of [statsRes, txRes, catsRes, budgetsRes, goalsRes, contribsRes]) {
      if (result.error) throw result.error;
    }

    const stats = statsRes.data;
    const currency = stats.currency ?? 'GBP';
    const categoriesById = new Map(catsRes.data.map((c) => [c.id, c]));
    const goalsById = new Map(goalsRes.data.map((g) => [g.id, g]));
    const events = [];

    const expensesByCategory = new Map();
    for (const tx of txRes.data) {
      if (tx.type !== 'expense') continue;
      expensesByCategory.set(
        tx.category_id,
        (expensesByCategory.get(tx.category_id) ?? 0) + Number(tx.amount),
      );
    }

    const budgetWins = budgetsRes.data
      .map((budget) => {
        const category = categoriesById.get(budget.category_id);
        const spent = expensesByCategory.get(budget.category_id) ?? 0;
        const rawLimit = Number(budget.amount_limit);
        const weeklyLimit = budget.period === 'weekly' ? rawLimit : rawLimit / WEEKS_PER_MONTH;
        const saved = weeklyLimit - spent;
        if (!category || spent <= 0 || saved <= 0) return null;
        return {
          type: 'under_budget',
          title: `You stayed under budget on ${category.name} this week`,
          body: `${formatMoney(saved, currency)} saved`,
          at: latestDateForCategory(txRes.data, budget.category_id, todayISO),
          icon: category.icon ?? '💚',
          rank: saved,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 3);
    events.push(...budgetWins.map(({ rank: _rank, ...event }) => event));

    if (stats.current_streak > 0) {
      events.push({
        type: 'streak',
        title: `${stats.current_streak}-day streak!`,
        body:
          stats.current_streak >= 7
            ? 'That money habit is looking sharp.'
            : 'Tiny logs, real momentum.',
        at: stats.last_logged_date ?? todayISO,
        icon: '🔥',
      });
    }

    if (stats.shields > 0) {
      events.push({
        type: 'shield',
        title: 'Shield earned',
        body: `${stats.shields} banked — missing one day will not break your streak.`,
        at: stats.last_logged_date ?? todayISO,
        icon: '🛡️',
      });
    }

    const runningGoalAmounts = new Map(
      goalsRes.data.map((goal) => [goal.id, Number(goal.current_amount)]),
    );
    for (const contribution of contribsRes.data) {
      const goal = goalsById.get(contribution.goal_id);
      if (!goal) continue;
      const target = Number(goal.target_amount);
      const amount = Number(contribution.amount);
      const afterAmount = runningGoalAmounts.get(goal.id) ?? Number(goal.current_amount);
      const beforeAmount = Math.max(0, afterAmount - amount);
      runningGoalAmounts.set(goal.id, beforeAmount);

      const beforePct = target > 0 ? Math.round(Math.min(beforeAmount / target, 1) * 100) : 0;
      const afterPct = target > 0 ? Math.round(Math.min(afterAmount / target, 1) * 100) : 0;

      events.push({
        type: 'savings',
        title: `${formatMoney(amount, currency)} added to ${goal.name}`,
        body: target > 0 ? `${beforePct}% → ${afterPct}% funded` : 'Your goal just got closer.',
        at: contribution.created_at ?? contribution.date,
        icon: goal.emoji ?? '🎯',
      });
    }

    const wins = events
      .filter((event) => new Date(event.at).getTime() >= eventCutoff.getTime())
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 10)
      .map((event) => ({ ...event, at: dateOnly(new Date(event.at)) }));

    res.json({ wins });
  } catch (err) {
    next(err);
  }
});

export default router;
