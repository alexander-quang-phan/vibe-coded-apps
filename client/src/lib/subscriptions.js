import { formatMoney } from './format';

// Display fallback order from Task 6.2.1:
//   1. user-given override.displayName
//   2. description-derived name (from the detector)
//   3. synthetic placeholder built from cadence + amount + category
// Task 6.12a added a third cadence. This used to be
// `cadence === 'annual' ? 'Annual' : 'Monthly'`, which silently labelled every
// manually-marked WEEKLY recurrence "Monthly" — the server sends 'weekly'.
const CADENCE_LABELS = { annual: 'Annual', monthly: 'Monthly', weekly: 'Weekly' };

export function cadenceLabel(cadence) {
  return CADENCE_LABELS[cadence] ?? 'Monthly';
}

export function subscriptionLabel(sub, currency) {
  if (sub.displayName) return sub.displayName;
  if (sub.name) return sub.name;
  const amount = formatMoney(sub.amount, currency);
  const category = sub.category?.name ?? 'Subscription';
  return `${cadenceLabel(sub.cadence)} ${amount} ${category}`;
}
