import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { excludeSpecial } from '../lib/special.js';
import { resolveTotalBudget, buildPace } from '../lib/overallBudget.js';
import { dayInZone, addMonths, daysInMonth, dayOfMonth } from '../lib/month.js';
import { userTimeZone } from '../lib/userZone.js';

const router = Router();

const COLD_START_MIN_DAYS = 3;

// All of this is the USER's month, not the server's. `daysElapsed` in
// particular drove the pace line: on the 1st in Paris the server still said the
// last day of the previous month, so the projection divided by ~30 instead of 1.
function bounds(timeZone, d = new Date()) {
  const today = dayInZone(timeZone, d);
  const ym = today.slice(0, 7);
  const lastYm = addMonths(ym, -1);
  return {
    firstISO: `${ym}-01`,
    nextFirstISO: `${addMonths(ym, 1)}-01`,
    lastMonthFirstISO: `${lastYm}-01`,
    daysInMonth: daysInMonth(ym),
    daysInLastMonth: daysInMonth(lastYm),
    daysElapsed: dayOfMonth(today),
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
    } = bounds(await userTimeZone(req.user.id));

    const [thisMonthRes, lastMonthRes, budgetsRes, statsRes] = await Promise.all([
      supabase
        .from('transactions')
        // category_id is needed so the pace maths can measure spend on the
        // same basis as the limit it's compared against (Phase 10 A4).
        .select('amount, category_id, is_special')
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
        .select('category_id, amount_limit')
        .eq('user_id', req.user.id)
        .eq('period', 'monthly'),
      supabase
        .from('user_stats')
        .select('monthly_limit, special_expenses_enabled')
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
    // Phase 10 (A4/A5). `pace` now measures spend on the SAME basis as the
    // limit it's compared against — see lib/overallBudget.js. Before this,
    // target came from the budgeted categories while spent counted every
    // category, so partial budgeting read as permanently ahead of pace.
    // monthly_limit is also no longer gated behind simple_mode: an overall
    // budget is exactly as meaningful in normal mode.
    const spendByCat = new Map();
    for (const t of thisMonthTx) {
      spendByCat.set(t.category_id, (spendByCat.get(t.category_id) ?? 0) + Number(t.amount));
    }
    const resolved = resolveTotalBudget({
      monthlyLimit: statsRes.data.monthly_limit,
      monthlyBudgets: budgetsRes.data,
      spendByCat,
    });
    const monthlyBudget = resolved.limit;
    const pace = buildPace({
      limit: resolved.limit,
      spent: resolved.spent,
      daysElapsed,
      daysInMonth,
    });

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
