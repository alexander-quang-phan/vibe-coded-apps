import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { excludeSpecial } from '../lib/special.js';
import { dayInZone } from '../lib/month.js';
import { userTimeZone } from '../lib/userZone.js';

import { selectFor, decodeRows } from '../lib/encryptionCodec.js';

const router = Router();

// Phase 9.5 Part A. Read-only route over four encrypted tables. Everything is
// aggregated into a `wins` array of named fields, so nothing here returns a
// database row and no `presentRow` is needed — decoding before the arithmetic is
// enough.
const WINS_TX_COLUMNS = 'id, amount, type, category_id, date, created_at, is_special';
const WINS_CAT_COLUMNS = 'id, name, icon, color, type';
const WINS_BUDGET_COLUMNS = 'id, category_id, amount_limit, period';
const WINS_GOAL_COLUMNS = 'id, name, emoji, target_amount, current_amount';
const WINS_CONTRIB_COLUMNS = 'id, goal_id, amount, date, created_at';
const DAY_MS = 86_400_000;
const WEEKS_PER_MONTH = 4.345;

function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

// The user's day, not the server's — a win earned at 00:30 in Paris belongs to
// that day, not to the one the server is still finishing.
function startOfUserDay(timeZone, d = new Date()) {
  return new Date(`${dayInZone(timeZone, d)}T00:00:00Z`);
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
    const today = startOfUserDay(await userTimeZone(req.user.id));
    const weekStart = new Date(today.getTime() - 6 * DAY_MS);
    const eventCutoff = new Date(today.getTime() - 14 * DAY_MS);
    const todayISO = dateOnly(today);
    const weekStartISO = dateOnly(weekStart);

    const [statsRes, txRes, catsRes, budgetsRes, goalsRes, contribsRes] = await Promise.all([
      supabase
        .from('user_stats')
        .select('current_streak, longest_streak, shields, last_logged_date, currency, special_expenses_enabled')
        .eq('user_id', req.user.id)
        .single(),
      supabase
        .from('transactions')
        .select(selectFor('transactions', WINS_TX_COLUMNS))
        .eq('user_id', req.user.id)
        .gte('date', weekStartISO)
        .lte('date', todayISO)
        .limit(500),
      supabase
        .from('categories')
        .select(selectFor('categories', WINS_CAT_COLUMNS))
        .eq('user_id', req.user.id),
      supabase
        .from('budgets')
        .select(selectFor('budgets', WINS_BUDGET_COLUMNS))
        .eq('user_id', req.user.id),
      supabase
        .from('savings_goals')
        .select(selectFor('savings_goals', WINS_GOAL_COLUMNS))
        .eq('user_id', req.user.id),
      supabase
        .from('savings_contributions')
        .select(selectFor('savings_contributions', WINS_CONTRIB_COLUMNS))
        .eq('user_id', req.user.id)
        .gte('created_at', eventCutoff.toISOString())
        .order('created_at', { ascending: false })
        .limit(25),
    ]);

    for (const result of [statsRes, txRes, catsRes, budgetsRes, goalsRes, contribsRes]) {
      if (result.error) throw result.error;
    }

    // Decode once, here at the boundary; every calculation below is unchanged.
    const uid = req.user.id;
    const txRows = decodeRows('transactions', uid, txRes.data);
    const catRows = decodeRows('categories', uid, catsRes.data);
    const budgetRows = decodeRows('budgets', uid, budgetsRes.data);
    const goalRows = decodeRows('savings_goals', uid, goalsRes.data);
    const contribRows = decodeRows('savings_contributions', uid, contribsRes.data);

    const stats = statsRes.data;
    const currency = stats.currency ?? 'GBP';
    const categoriesById = new Map(catRows.map((c) => [c.id, c]));
    const goalsById = new Map(goalRows.map((g) => [g.id, g]));
    const events = [];

    const specialEnabled = !!stats.special_expenses_enabled;
    const expensesByCategory = new Map();
    for (const tx of excludeSpecial(txRows, specialEnabled)) {
      if (tx.type !== 'expense') continue;
      expensesByCategory.set(
        tx.category_id,
        (expensesByCategory.get(tx.category_id) ?? 0) + Number(tx.amount),
      );
    }

    const budgetWins = budgetRows
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
          at: latestDateForCategory(txRows, budget.category_id, todayISO),
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
      goalRows.map((goal) => [goal.id, Number(goal.current_amount)]),
    );
    for (const contribution of contribRows) {
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
