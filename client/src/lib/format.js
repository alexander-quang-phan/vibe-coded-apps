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
