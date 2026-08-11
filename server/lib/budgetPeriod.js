import { daysInMonth } from './month.js';

/**
 * The limit a budget should be measured against, for a MONTH of spend.
 *
 * Budgets carry a `period` of 'monthly' or 'weekly' — both offered in the UI
 * (`client/src/pages/Budgets.jsx`) — but every surface computes spend over the
 * calendar month. A weekly limit was being compared against that month directly,
 * so a £50/week budget read as ~430% used after a normal month, and Ask Trim
 * reported the same nonsense independently.
 *
 * Scaling the limit is chosen over measuring weekly budgets against the current
 * week, because it keeps ONE time basis on the page. Mixing "spent this month"
 * rows with "spent this week" rows in the same list, with the same bar, would be
 * a harder thing for Alex to read correctly than a scaled limit.
 *
 * Callers should surface the raw `limit` and `period` too, so the UI can still
 * say "£50/week" while the bar reflects the real position.
 *
 * @param {number} limit  the budget's own amount_limit
 * @param {string} period 'monthly' | 'weekly'
 * @param {string} ym     'YYYY-MM' of the month being measured
 */
export function monthlyEquivalentLimit(limit, period, ym) {
  if (period !== 'weekly') return limit;
  // Actual days in THIS month, not a flat 4 weeks — 4 would understate the
  // allowance by up to three days and make February and March disagree.
  return Number(((limit * daysInMonth(ym)) / 7).toFixed(2));
}
