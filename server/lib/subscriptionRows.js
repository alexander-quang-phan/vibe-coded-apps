/**
 * Phase 17 — the ONE builder for GET /api/subscriptions rows.
 *
 * routes/subscriptions.js and scripts/devMock.js both import this, so the real
 * page and the mock page cannot drift apart (BUGS-FIXED recurring shape #2: a
 * route and its mock that disagree ship a difference nobody sees). Pure: callers
 * do the database reads and the timezone conversion.
 *
 * Every row is built FIELD BY FIELD. Spreading a detector row or a decoded database
 * row into the response is how ciphertext columns and user ids reach the browser
 * (BUGS-FIXED 2026-09-23 #5).
 */
import { manualMerchantKey, isTracked, subscriptionCost, nextExpectedFrom, CADENCE_DAYS } from './recurrences.js';
import {
  prototypeOf, isSameSubscription, isLaterCharge, isExactNote, daysBetween, TOLERANCE_DAYS,
} from './subscriptionMatch.js';
import { normaliseMerchant } from './merchant.js';

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** The category fields the client renders, and nothing else. */
export function categoryShape(cat) {
  return cat ? { id: cat.id, name: cat.name, icon: cat.icon, color: cat.color } : null;
}

/**
 * A detected subscription, decorated with the user's override.
 * `lastAmount` is used for matching only and deliberately NOT returned.
 */
export function buildDetectedRow(d, override, category) {
  return {
    merchantKey: d.merchantKey,
    name: d.name,
    inferred: d.inferred,
    cadence: d.cadence,
    cadenceDays: d.cadenceDays,
    amount: d.amount,
    monthlyCost: d.monthlyCost,
    annualCost: d.annualCost,
    lastCharged: d.lastCharged,
    nextExpected: d.nextExpected,
    totalPaid: d.totalPaid,
    occurrences: d.occurrences,
    categoryId: d.categoryId,
    category: categoryShape(category),
    status: override?.status ?? 'active',
    displayName: override?.display_name ?? null,
    decidedAt: override?.decided_at ?? null,
    source: 'auto',
    tracking: false,
  };
}

/**
 * A manual row: either "Repeat this" (auto-logged) or tracked (marked by Alex).
 *
 * Tracked rows are DERIVED from their attached charges every time — amount from the
 * latest charge, next expected from the last charge plus one cycle — so editing,
 * re-dating or deleting a charge can never leave a stale figure. With nothing
 * attached, the dates are null (never computed: that would throw and 500 the page)
 * and the amount falls back to what was stored at marking time.
 *
 * Repeat-this rows keep their stored amount and next_run_at, exactly as before.
 */
export function buildManualRow(rec, linked, category) {
  const tracking = isTracked(rec);
  let latest = null;
  for (const t of linked) if (isLaterCharge(t, latest)) latest = t;
  const lastCharged = latest ? latest.date : null;
  const amount = tracking && latest ? Number(latest.amount) : Number(rec.amount);
  const { monthlyCost, annualCost } = subscriptionCost(amount, rec.interval);
  return {
    merchantKey: manualMerchantKey(rec.id),
    name: rec.description || null,
    inferred: false,
    cadence: rec.interval,
    cadenceDays: CADENCE_DAYS[rec.interval] ?? null,
    amount: round2(amount),
    monthlyCost,
    annualCost,
    lastCharged,
    nextExpected: tracking ? nextExpectedFrom(lastCharged, rec.interval) : rec.next_run_at,
    totalPaid: round2(linked.reduce((sum, t) => sum + Number(t.amount), 0)),
    occurrences: linked.length,
    categoryId: rec.category_id,
    category: categoryShape(category),
    status: rec.cancelled_at ? 'cancelled' : 'active',
    displayName: null,
    decidedAt: rec.cancelled_at ?? null,
    source: 'manual',
    tracking,
  };
}

/**
 * Tracked subscriptions as matcher prototypes.
 * @param cancelledDayOf  (cancelled_at) => the user-local day; the route passes dayInZone.
 */
export function trackedPrototypes(recurrences, linkedById, cancelledDayOf) {
  return recurrences.filter(isTracked).map((r) => prototypeOf(r, linkedById.get(r.id) ?? [], {
    cancelledDay: r.cancelled_at ? cancelledDayOf(r.cancelled_at) : null,
  }));
}

/**
 * Active Repeat-this schedules as READ-ONLY prototypes. Nothing is ever attached to
 * them by hand; they exist so marking an expense with the same note can be refused
 * instead of creating a second subscription for a charge Trim already logs itself.
 */
export function repeatPrototypes(recurrences, linkedById) {
  return recurrences
    .filter((r) => r.auto_log === true && !r.cancelled_at)
    .map((r) => prototypeOf(r, linkedById.get(r.id) ?? []));
}

/** The active Repeat-this schedule with exactly this expense's note, or null. */
export function repeatingFor(expense, repeatProtos) {
  const key = normaliseMerchant(expense.description);
  return key ? repeatProtos.find((p) => isExactNote({ key }, p)) ?? null : null;
}

/** A detected row as a matcher item. A synthetic `auto:` key has no note. */
function detectedItem(d) {
  return { key: d.merchantKey.startsWith('auto:') ? null : d.merchantKey, amount: d.lastAmount ?? d.amount };
}

/**
 * Drop detected rows that are STRICTLY the same as a tracked subscription — the exact
 * note it was marked with, within ±30% — when that subscription is active, or
 * cancelled with nothing detected since the cancellation day (its old unattached
 * charges must not come back as an ACTIVE row, or cancelling would not lower "Per
 * month"). Synthetic no-note rows are never dropped: that would be a guess.
 */
export function suppressDetected(detected, protos) {
  return detected.filter((d) => !protos.some((p) => {
    const item = detectedItem(d);
    const strictlySame = isSameSubscription(item, p);
    // Its own history: the exact marked note, the same cadence, and the detected
    // run ends RIGHT WHERE the attached run begins (within one cycle + tolerance).
    // That is the old price of the same service (Disney+ at £1.99 before it became
    // £7.99) — whatever the amount. A same-note run that ended long before, or bills
    // on a different cadence, is a different subscription and stays visible.
    const ownHistory = !!item.key && item.key === p.ownKey && !!p.firstCharged
      && d.cadence === p.cadence
      && d.lastCharged <= p.firstCharged
      && daysBetween(p.firstCharged, d.lastCharged)
        <= (CADENCE_DAYS[p.cadence] ?? 30) + (TOLERANCE_DAYS[p.cadence] ?? 5);
    if (!strictlySame && !ownHistory) return false;
    return p.active || d.lastCharged <= p.cancelledDay;
  }));
}

/** The summary strip. */
export function summarise(subscriptions) {
  const active = subscriptions.filter((s) => s.status === 'active');
  const cancelled = subscriptions.filter((s) => s.status === 'cancelled');
  const dismissed = subscriptions.filter((s) => s.status === 'dismissed');
  const activeMonthly = active.reduce((sum, s) => sum + s.monthlyCost, 0);
  const cancelledMonthly = cancelled.reduce((sum, s) => sum + s.monthlyCost, 0);
  return {
    activeCount: active.length,
    cancelledCount: cancelled.length,
    dismissedCount: dismissed.length,
    activeMonthly: round2(activeMonthly),
    activeAnnual: round2(activeMonthly * 12),
    cancelledMonthly: round2(cancelledMonthly),
    cancelledAnnual: round2(cancelledMonthly * 12),
  };
}
