import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

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

function paceLabelFor(currentDailyPace, lastMonthDailyPace) {
  if (!lastMonthDailyPace) return 'tracking calmly';
  const ratio = currentDailyPace / lastMonthDailyPace;
  if (ratio > 1.1) return 'spending faster than last month';
  if (ratio < 0.9) return 'ahead of pace';
  return 'tracking calmly';
}

router.get('/month', async (req, res, next) => {
  try {
    const {
      firstISO,
      nextFirstISO,
      lastMonthFirstISO,
      daysInMonth,
      daysInLastMonth,
      daysElapsed,
    } = bounds();

    const [thisMonthRes, lastMonthRes, budgetsRes] = await Promise.all([
      supabase
        .from('transactions')
        .select('amount')
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .gte('date', firstISO)
        .lt('date', nextFirstISO),
      supabase
        .from('transactions')
        .select('amount')
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .gte('date', lastMonthFirstISO)
        .lt('date', firstISO),
      supabase
        .from('budgets')
        .select('amount_limit')
        .eq('user_id', req.user.id)
        .eq('period', 'monthly'),
    ]);

    for (const r of [thisMonthRes, lastMonthRes, budgetsRes]) {
      if (r.error) throw r.error;
    }

    const spendSoFar = thisMonthRes.data.reduce((sum, t) => sum + Number(t.amount), 0);
    const lastMonthSpend = lastMonthRes.data.reduce(
      (sum, t) => sum + Number(t.amount),
      0,
    );
    const monthlyBudget = budgetsRes.data.length === 0
      ? null
      : budgetsRes.data.reduce((sum, b) => sum + Number(b.amount_limit), 0);

    if (daysElapsed < COLD_START_MIN_DAYS || thisMonthRes.data.length === 0) {
      return res.json({
        ready: false,
        daysElapsed,
        daysInMonth,
      });
    }

    const projectedSpend = (spendSoFar / daysElapsed) * daysInMonth;
    const delta = monthlyBudget !== null ? monthlyBudget - projectedSpend : null;
    const currentDailyPace = spendSoFar / daysElapsed;
    const lastMonthDailyPace = daysInLastMonth > 0 ? lastMonthSpend / daysInLastMonth : 0;

    res.json({
      ready: true,
      projectedSpend: Number(projectedSpend.toFixed(2)),
      monthlyBudget: monthlyBudget !== null ? Number(monthlyBudget.toFixed(2)) : null,
      delta: delta !== null ? Number(delta.toFixed(2)) : null,
      spendSoFar: Number(spendSoFar.toFixed(2)),
      daysElapsed,
      daysInMonth,
      paceLabel: paceLabelFor(currentDailyPace, lastMonthDailyPace),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
