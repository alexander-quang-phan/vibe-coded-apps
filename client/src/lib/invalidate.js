// One definition of "what goes stale when money changes".
//
// Every mutation used to hand-list its own invalidations, and they had all
// drifted apart: Quick Add refreshed six keys, the Dashboard's delete four, the
// Transactions edit five, Settings two — and ['affordability'] was refreshed by
// nothing at all, while CategoryManager targeted ['analytics', 6] when the only
// analytics query in the app is ['analytics', 24] (prefix matching means 6 never
// matched anything, so category renames never refreshed Analytics).
//
// The symptom was always the same: a screen quietly showing figures from before
// your last change until a hard refresh. Rather than fix four lists separately
// and let them drift again, they all call this.

// Every key whose data is derived from transactions, budgets or preferences.
// Listed as one-element arrays deliberately: TanStack Query matches by PREFIX,
// so ['analytics'] catches ['analytics', 24] and any future variant, whereas a
// key with the wrong second element matches nothing.
const MONEY_KEYS = [
  'dashboard',
  'transactions',
  'analytics',
  'projections',
  'budgets',
  'affordability',
  'special-groups',
  'subscriptions',
  'wins',
  'categories',
  'me',
];

/**
 * Refresh everything derived from the user's money.
 *
 * Deliberately blunt. These are all cheap cached reads on a single-user app, and
 * the cost of an unnecessary refetch is far below the cost of one screen
 * disagreeing with another — which has now happened here more than once.
 *
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 */
export function invalidateMoney(queryClient) {
  for (const key of MONEY_KEYS) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}
