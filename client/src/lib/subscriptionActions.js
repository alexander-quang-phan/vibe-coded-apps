// Phase 17 — the three things you can do to a subscription from an expense, in one
// place, so the Edit dialog, the "Add a subscription" dialog and Quick Add's toast
// all send exactly the same requests and say exactly the same things.
//
// An action is one of:
//   { type: 'track',  interval: 'monthly'|'weekly'|'annual', includeIds: string[] }
//   { type: 'attach', merchantKey, reactivate: boolean, label }
//   { type: 'detach', merchantKey, label }

export function runSubscriptionAction(api, transactionId, action) {
  if (action.type === 'track') {
    return api.post('/api/subscriptions/track', {
      transactionId,
      interval: action.interval,
      includeTransactionIds: action.includeIds ?? [],
    });
  }
  const key = encodeURIComponent(action.merchantKey);
  if (action.type === 'attach') {
    return api.post(`/api/subscriptions/${key}/attach`, {
      transactionId,
      reactivate: !!action.reactivate,
    });
  }
  if (action.type === 'detach') {
    return api.post(`/api/subscriptions/${key}/detach`, { transactionId });
  }
  throw new Error(`Unknown subscription action: ${action.type}`);
}

/** The success toast for an action: { title, description }. */
export function subscriptionActionMessage(action) {
  if (action.type === 'track') {
    return { title: 'Tracking it as a subscription 🔁', description: 'See it on Subscriptions.' };
  }
  if (action.type === 'attach') {
    return action.reactivate
      ? { title: `${action.label} is back 🔁`, description: 'Marked active and added this charge.' }
      : { title: `Added to ${action.label} 🔁`, description: 'Its monthly cost follows this charge if it is the newest.' };
  }
  return { title: `Removed from ${action.label}`, description: 'The expense itself is unchanged.' };
}

/**
 * "Nothing to apply": the panel is only informing (Trim already spots this, or it
 * needs a category first). Distinct from null, which means a choice is still
 * pending — so Save stays usable for the dialog's other edits.
 */
export const NO_ACTION = Object.freeze({ type: 'none' });

/** True when the action can be submitted (a track needs a cadence). */
export function isActionReady(action) {
  if (!action || action.type === 'none') return false;
  if (action.type === 'track') return !!action.interval;
  return !!action.merchantKey;
}

/** Save may proceed: either a ready action, or nothing to apply. */
export function allowsSave(action) {
  return action?.type === 'none' || isActionReady(action);
}
