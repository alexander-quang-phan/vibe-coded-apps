const CURRENCY_LOCALE = {
  GBP: 'en-GB',
  USD: 'en-US',
  AUD: 'en-AU',
  VND: 'vi-VN',
  PLN: 'pl-PL',
};

export function formatMoney(amount, currency = 'GBP', { compact = false } = {}) {
  const locale = CURRENCY_LOCALE[currency] ?? 'en-GB';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'VND' ? 0 : 2,
    notation: compact ? 'compact' : 'standard',
  }).format(amount ?? 0);
}

// The user's LOCAL calendar day, as YYYY-MM-DD. The one definition — every
// "today" in the client must come from here.
//
// It is deliberately local, not UTC. This used to be
// `new Date().toISOString().slice(0, 10)`, which is the UTC day: anything logged
// between local midnight and UTC midnight was stamped with YESTERDAY's date,
// then rendered by formatDate() below — which reads local — as "Yesterday". On
// the 1st of a month it also filed the row into the previous month for the
// dashboard, budgets and the running average. That window is about an hour a day
// in London BST and two in CEST, so it bit hardest exactly when Alex was abroad.
//
// Built from the local parts rather than toLocaleDateString('en-CA') so the
// output can never depend on the browser's locale data.
export function todayISO(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The user's local calendar month, as YYYY-MM. */
export function thisMonthISO(d = new Date()) {
  return todayISO(d).slice(0, 7);
}

// Absolute dates render as dd/mm/yyyy everywhere (Alex's preference);
// 'relative' keeps the friendly Today/Yesterday labels for the last week.
export function formatDate(iso, { format = 'short' } = {}) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (format === 'relative') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((today - d) / 86_400_000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays > 1 && diffDays < 7) return `${diffDays} days ago`;
  }
  return d.toLocaleDateString('en-GB'); // dd/mm/yyyy
}
