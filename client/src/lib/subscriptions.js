import { formatMoney } from './format';

// Display fallback order from Task 6.2.1:
//   1. user-given override.displayName
//   2. description-derived name (from the detector)
//   3. synthetic placeholder built from cadence + amount + category
export function subscriptionLabel(sub, currency) {
  if (sub.displayName) return sub.displayName;
  if (sub.name) return sub.name;
  const cadence = sub.cadence === 'annual' ? 'Annual' : 'Monthly';
  const amount = formatMoney(sub.amount, currency);
  const category = sub.category?.name ?? 'Subscription';
  return `${cadence} ${amount} ${category}`;
}
