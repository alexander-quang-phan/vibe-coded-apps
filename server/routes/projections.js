import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { excludeSpecial } from '../lib/special.js';

const router = Router();

const COLD_START_MIN_DAYS = 3;

function bounds(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const nextFirst = new Date(Date.UTC(y, m + 1, 1));
  const lastMonthFirst = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const daysInLastMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    firstISO: first.toISOString().slice(0, 10),
    nextFirstISO: nextFirst.toISOString().slice(0, 10),
    lastMonthFirstISO: lastMonthFirst.toISOString().slice(0, 10),
    daysInMonth,
    daysInLastMonth,
    daysElapsed: d.getUTCDate(),
  };
}

function paceLabelFor(projectedSpend, lastMonthSpend) {
  if (!lastMonthSpend) return 'tracking calmly';
  const ratio = projectedSpend / lastMonthSpend;
  if (ratio > 1.1) return 'spending faster than last month';
  if (ratio < 0.9) return 'ahead of pace';
  return 'tracking calmly';
}

// One dominant charge early in the month (rent on the 1st) used to explode the
// linear projection ("on pace to overshoot by £5,600"). When a single
// transaction is >40% of the month's spend so far, treat it as a one-off:
// count it once, and project the run-rate from everything else.
function projectSpend({ amounts, spendSoFar, daysElapsed, daysInMonth }) {
  const largest = amounts.length > 0 ? Math.max(...amounts) : 0;
  if (spendSoFar > 0 && largest / spendSoFar > 0.4) {
    const rest = spendSoFar - largest;
    return spendSoFar + (rest / daysElapsed) * (daysInMonth - daysElapsed);
  }
  return (spendSoFar / daysElapsed) * daysInMonth;
}

router.get('/month', async (req, res, next) => {
  try {
    const {
      firstISO,
      nextFirstISO,
      lastMonthFirstISO,
      daysInMonth,
      daysElapsed,
    } = bounds();

    const [thisMonthRes, lastMonthRes, budgetsRes, statsRes] = await Promise.all([
      supabase
        .from('transactions')
        .select('amount, is_special')
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .gte('date', firstISO)
        .lt('date', nextFirstISO),
      supabase
        .from('transactions')
        .select('amount, is_special')
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .gte('date', lastMonthFirstISO)
        .lt('date', firstISO),
      supabase
        .from('budgets')
        .select('amount_limit')
        .eq('user_id', req.user.id)
        .eq('period', 'monthly'),
      supabase
        .from('user_stats')
        .select('simple_mode, monthly_limit, special_expenses_enabled')
        .eq('user_id', req.user.id)
        .single(),
    ]);

    for (const r of [thisMonthRes, lastMonthRes, budgetsRes, statsRes]) {
      if (r.error) throw r.error;
    }

    const specialEnabled = !!statsRes.data.special_expenses_enabled;
    const thisMonthTx = excludeSpecial(thisMonthRes.data, specialEnabled);
    const lastMonthTx = excludeSpecial(lastMonthRes.data, specialEnabled);

    const spendSoFar = thisMonthTx.reduce((sum, t) => sum + Number(t.amount), 0);
    const lastMonthSpend = lastMonthTx.reduce(
      (sum, t) => sum + Number(t.amount),
      0,
    );
    const monthlyBudget = budgetsRes.data.length === 0
      ? null
      : budgetsRes.data.reduce((sum, b) => sum + Number(b.amount_limit), 0);

    const stats = statsRes.data;
    const budgetSource = stats?.simple_mode && stats?.monthly_limit !== null
      ? Number(stats.monthly_limit)
      : monthlyBudget; // sum of monthly budgets, or null
    const pace = budgetSource === null || budgetSource <= 0
      ? null
      : {
          target: Number(((budgetSource * daysElapsed) / daysInMonth).toFixed(2)),
          spent: Number(spendSoFar.toFixed(2)),
          delta: Number(((budgetSource * daysElapsed) / daysInMonth - spendSoFar).toFixed(2)),
        };

    if (daysElapsed < COLD_START_MIN_DAYS || thisMonthTx.length === 0) {
      return res.json({
        ready: false,
        daysElapsed,
        daysInMonth,
        pace,
      });
    }

    const projectedSpend = projectSpend({
      amounts: thisMonthTx.map((t) => Number(t.amount)),
      spendSoFar,
      daysElapsed,
      daysInMonth,
    });
    const delta = monthlyBudget !== null ? monthlyBudget - projectedSpend : null;

    res.json({
      ready: true,
      projectedSpend: Number(projectedSpend.toFixed(2)),
      monthlyBudget: monthlyBudget !== null ? Number(monthlyBudget.toFixed(2)) : null,
      delta: delta !== null ? Number(delta.toFixed(2)) : null,
      spendSoFar: Number(spendSoFar.toFixed(2)),
      daysElapsed,
      daysInMonth,
      paceLabel: paceLabelFor(projectedSpend, lastMonthSpend),
      pace,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
