// Phase 12 — client half of foreign-currency entry.
//
// This file is for PREVIEW ONLY. The figure actually stored is derived
// server-side in server/lib/fx.js from the original amount and the rate, so the
// two can never disagree; what happens here just shows the user what they are
// about to log. Keep the rounding rule in step with the server's all the same —
// a preview that differs from the saved value is its own kind of bug.

// The currencies Frankfurter (ECB) quotes, which is what /api/fx can price.
// A user's own base currency is always offered too, even if it is not here —
// VND is a Trim base currency but has no ECB rate, so it needs a typed rate.
export const QUOTABLE_CURRENCIES = [
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
  'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR',
  'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD',
  'ZAR',
];

const ZERO_DECIMAL = new Set(['VND', 'JPY', 'KRW', 'ISK', 'CLP', 'HUF']);

/** Mirrors decimalsFor in server/lib/fx.js. */
export function decimalsFor(currency) {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

/**
 * What the server will store, computed the same way. Returns null when the
 * inputs are not yet complete enough to show anything.
 */
export function previewConvert({ originalAmount, fxRate, baseCurrency }) {
  if (!Number.isFinite(originalAmount) || originalAmount <= 0) return null;
  if (!Number.isFinite(fxRate) || fxRate <= 0) return null;
  return Number((originalAmount * fxRate).toFixed(decimalsFor(baseCurrency)));
}

/** Currency list to offer, with the user's own first and deduplicated. */
export function currencyOptions(baseCurrency) {
  return [baseCurrency, ...QUOTABLE_CURRENCIES.filter((c) => c !== baseCurrency)];
}
