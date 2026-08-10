// Phase 12 — foreign-currency expenses.
//
// The one place that turns "what the user typed abroad" into "the number stored
// in transactions.amount". Kept pure and in one file for the same reason
// lib/overallBudget.js and lib/runningAverage.js are: a money rule implemented
// twice eventually disagrees with itself.
//
// The invariant the whole feature rests on: `transactions.amount` is ALWAYS in
// the user's own default currency. Nothing downstream — budgets, analytics,
// projections, affordability, the running average — knows or cares that a row
// was originally paid in euros. That is what keeps this feature additive.

// Currencies quoted without minor units. Mirrors ZERO_DECIMAL in
// client/src/components/ui/money-input.jsx and the maximumFractionDigits rule in
// client/src/lib/format.js — keep the three in step.
const ZERO_DECIMAL = new Set(['VND', 'JPY', 'KRW', 'ISK', 'CLP', 'HUF']);

// Only for the human-readable audit line. A missing symbol is not an error; we
// fall back to the ISO code, which is unambiguous if less pretty.
const SYMBOLS = {
  EUR: '€',
  GBP: '£',
  USD: '$',
  AUD: 'A$',
  VND: '₫',
  PLN: 'zł',
  CHF: 'CHF ',
  JPY: '¥',
};

/** Minor-unit count for a currency. Unknown codes get the common case. */
export function decimalsFor(currency) {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

/**
 * Convert a foreign amount into the user's base currency.
 *
 * Rounding is to the BASE currency's precision, never the original's — a
 * VND-based user must never end up holding 38.50 dong.
 *
 * @param {{originalAmount: number, fxRate: number, baseCurrency: string}} args
 *   `fxRate` is units of base per 1 unit of original.
 * @returns {number} the amount to store in transactions.amount
 */
export function convertToBase({ originalAmount, fxRate, baseCurrency }) {
  if (!Number.isFinite(originalAmount) || originalAmount <= 0) {
    throw new Error('fx: originalAmount must be a positive finite number');
  }
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error('fx: fxRate must be a positive finite number');
  }
  const decimals = decimalsFor(baseCurrency);
  return Number((originalAmount * fxRate).toFixed(decimals));
}

/** "€45.00 at 0.85565" — the line shown under a converted transaction. */
export function describeConversion({ originalAmount, originalCurrency, fxRate }) {
  const symbol = SYMBOLS[originalCurrency] ?? `${originalCurrency} `;
  const amount = originalAmount.toFixed(decimalsFor(originalCurrency));
  return `${symbol}${amount} at ${fxRate}`;
}
