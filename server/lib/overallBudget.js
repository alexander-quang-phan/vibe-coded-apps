// Phase 10 (A5) — the single place that decides what "your total budget" means.
//
// Three endpoints used to answer this question independently and disagree:
//   budgets.js       had no notion of a total at all
//   projections.js   summed the category limits for the TARGET but measured
//                    ALL expense spend as the ACTUAL — so anyone who budgeted
//                    2 of 9 categories was permanently "ahead of pace"
//   affordability.js summed the same limits but correctly measured only the
//                    spend inside those budgeted categories
// Two different totals on the same Dashboard screen. This module ends that.
//
// The rule:
//   • An overall monthly budget (user_stats.monthly_limit), when set, IS the
//     total — and EVERY expense category counts against it. That's what Alex
//     asked for: "I want to spend 1200 in total this month, and that will
//     include everything from all categories."
//   • With no overall budget we keep the old behaviour: the sum of the monthly
//     category budgets, measured only against spend in those categories.
//
// Note monthly_limit is no longer gated behind simple_mode. It was already the
// right column; it was just unreachable from normal mode.

const round2 = (n) => Number(n.toFixed(2));

/**
 * @param monthlyLimit  user_stats.monthly_limit (number | null)
 * @param monthlyBudgets rows of {category_id, amount_limit}, period='monthly'
 * @param spendByCat    Map<categoryId, number> of this month's countable spend
 * @returns {{limit: number|null, spent: number, source: 'overall'|'categories'|'none'}}
 */
export function resolveTotalBudget({ monthlyLimit, monthlyBudgets = [], spendByCat }) {
  const allSpend = [...spendByCat.values()].reduce((sum, v) => sum + v, 0);
  const overall =
    monthlyLimit === null || monthlyLimit === undefined ? null : Number(monthlyLimit);

  if (overall !== null && overall > 0) {
    return { limit: round2(overall), spent: round2(allSpend), source: 'overall' };
  }

  if (monthlyBudgets.length === 0) {
    return { limit: null, spent: round2(allSpend), source: 'none' };
  }

  const limit = monthlyBudgets.reduce((sum, b) => sum + Number(b.amount_limit), 0);
  const budgetedIds = new Set(monthlyBudgets.map((b) => b.category_id));
  const budgetedSpend = [...spendByCat.entries()]
    .filter(([catId]) => budgetedIds.has(catId))
    .reduce((sum, [, v]) => sum + v, 0);
  return { limit: round2(limit), spent: round2(budgetedSpend), source: 'categories' };
}

/**
 * The pace object the client renders (Task 9.3, extended in Phase 10 A4).
 *
 * `delta` keeps its original sign convention — target minus spent, so negative
 * means spending faster than the flat run-rate. `perDayLeft` is deliberately
 * floored at 0: once you're over budget a negative per-day figure is noise, so
 * the client switches to reading `overBy` instead.
 */
export function buildPace({ limit, spent, daysElapsed, daysInMonth }) {
  if (limit === null || limit <= 0) return null;
  const target = (limit * daysElapsed) / daysInMonth;
  // Includes today — you can still spend it.
  const daysRemaining = Math.max(1, daysInMonth - daysElapsed + 1);
  const remaining = limit - spent;
  return {
    target: round2(target),
    spent: round2(spent),
    delta: round2(target - spent),
    budget: round2(limit),
    daysRemaining,
    perDayLeft: remaining > 0 ? round2(remaining / daysRemaining) : 0,
    overBy: remaining < 0 ? round2(-remaining) : 0,
  };
}
