// The one definition of "what a normal month costs". Kept out of the route and
// out of the component for the same reason lib/overallBudget.js exists: a figure
// computed in two places eventually disagrees with itself on the same screen.
//
// COMPLETED months only. The month in progress is deliberately excluded — on the
// 10th, a third of a month's spending would drag the mean down, and the figure
// would creep upward all month instead of meaning "a normal month".

function isEmptyMonth(month) {
  return month.income === 0 && month.expenses === 0;
}

function mean(values) {
  const total = values.reduce((sum, v) => sum + v, 0);
  return Number((total / values.length).toFixed(2));
}

/**
 * @param {object} args
 * @param {Array<{ym: string, income: number, expenses: number, special: number}>} args.series
 *   Ascending months, as built by routes/analytics.js.
 * @param {number} args.months How many completed months to average over.
 * @param {string} args.currentYm 'YYYY-MM' of the month in progress.
 * @returns {null | {months: number, monthsUsed: number, from: string, to: string,
 *                   inclSpecial: number, exclSpecial: number, emptyYms: string[]}}
 */
export function buildRunningAverage({ series, months, currentYm }) {
  // 1. Drop leading pre-signup months. Same rule as MonthlyHistory.jsx:11, so the
  //    average and the history list agree on when the user's data starts.
  const firstWithData = series.findIndex((month) => !isEmptyMonth(month));
  const active = firstWithData === -1 ? [] : series.slice(firstWithData);

  // 2. Completed months only. Matched on ym rather than position, so this does
  //    not depend on how the caller sliced the series.
  const completed = active.filter((month) => month.ym !== currentYm);

  // 3. The window.
  const picked = completed.slice(-months);
  if (picked.length === 0) return null;

  return {
    months,
    monthsUsed: picked.length,
    from: picked[0].ym,
    to: picked[picked.length - 1].ym,
    inclSpecial: mean(picked.map((month) => month.expenses)),
    exclSpecial: mean(picked.map((month) => month.expenses - month.special)),
    // Anything still empty here is a genuine gap mid-history — step 1 already
    // removed the pre-signup run — so it may be a month the user forgot to log.
    emptyYms: picked.filter(isEmptyMonth).map((month) => month.ym),
  };
}
