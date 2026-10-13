// Pure schedule helpers for Task 6.12 (manually-marked recurring transactions).
// No DB access — both the nightly cron executor (lib/runRecurrences.js) and
// the transactions/subscriptions routes import this so the date math and key
// format stay unit-testable in isolation (see test/recurrences.test.js).

const MS_PER_DAY = 86_400_000;

export function addDaysISO(iso, days) {
  const t = new Date(`${iso}T00:00:00Z`).getTime() + days * MS_PER_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

function daysInUTCMonth(year, monthIndex /* 0-based */) {
  // Day 0 of the month AFTER `monthIndex` is the last day of `monthIndex`.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Advance an ISO date ('YYYY-MM-DD') by one schedule interval, UTC only.
 *
 * - 'weekly': always +7 days, no clamping needed.
 * - 'monthly': lands on the same day-of-month next month, clamped to that
 *   month's last day when it's shorter (31 Jan -> 28/29 Feb).
 *
 * The anchor-drift trap: if the CLAMPED result (28 Feb) is fed straight back
 * in using ITS OWN day-of-month as the target, March lands on the 28th too,
 * and the schedule quietly drifts from "the 31st of every month" down to
 * "the 28th of every month" forever. The fix is to always clamp from the
 * ORIGINAL anchor day, not from whatever day the previous (possibly
 * clamped) run happened to land on.
 *
 * `anchorDay` makes that explicit. The recurrences schema (locked by the
 * 6.12a brief) has no separate anchor column, so callers DERIVE it from data
 * already on the row — the day-of-month of `created_at` — rather than
 * storing a new one. See lib/runRecurrences.js and routes/transactions.js
 * for where that derivation happens. Defaults to the day-of-month of
 * `fromISODate` itself, which is only correct for the very first advance
 * (fromISODate IS the anchor at that point).
 */
export function nextRunDate(fromISODate, interval, anchorDay) {
  if (interval === 'weekly') return addDaysISO(fromISODate, 7);
  if (interval !== 'monthly') {
    throw new Error(`Unknown recurrence interval: ${interval}`);
  }

  const [y, m, d] = fromISODate.split('-').map(Number);
  const anchor = anchorDay ?? d;

  let targetYear = y;
  let targetMonthIndex = m; // m is 1-based; this is "next month", 0-based
  if (targetMonthIndex > 11) {
    targetMonthIndex = 0;
    targetYear += 1;
  }

  const lastDay = daysInUTCMonth(targetYear, targetMonthIndex);
  const day = Math.min(anchor, lastDay);
  const mm = String(targetMonthIndex + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

/**
 * Keep advancing until the result is strictly after `todayISO`. Used when a
 * schedule is overdue by more than one period (app/user asleep for weeks or
 * months) — the executor still only ever creates ONE transaction for "today"
 * (see runRecurrences.js); this just fast-forwards `next_run_at` to the next
 * real future date instead of leaving it stuck in the past, and without
 * stepping through (and the caller having to insert) one transaction per
 * missed period, which would spam the user and distort their budgets.
 */
export function advanceToFuture(fromISODate, interval, anchorDay, todayISO) {
  let next = nextRunDate(fromISODate, interval, anchorDay);
  while (next <= todayISO) {
    next = nextRunDate(next, interval, anchorDay);
  }
  return next;
}

/**
 * Rows due to fire: auto-logging, not cancelled, and scheduled today or earlier.
 *
 * FAILS CLOSED (Phase 17). A tracked subscription (`auto_log = false`) must never
 * create a transaction, so this fires only on an explicit `auto_log === true` and a
 * real date. A row whose `auto_log` was not selected — `undefined` — is not fired.
 * This is the third of three independent guards; the other two are the
 * `.eq('auto_log', true)` filters on the select and the claim in runRecurrences.js.
 */
export function dueRecurrences(rows, todayISO) {
  return rows.filter(
    (r) => r.auto_log === true && r.next_run_at && !r.cancelled_at && r.next_run_at <= todayISO,
  );
}

/** Days per cadence, for every cadence a subscription row can carry. */
export const CADENCE_DAYS = Object.freeze({ weekly: 7, monthly: 30, annual: 365 });

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Monthly and annual cost of one charge at a cadence. The ONE definition: the
 * route, devMock and the client all use these figures. Before Phase 17 any
 * non-monthly manual row was costed as weekly, which would have priced a yearly
 * subscription at 52 times its amount.
 */
export function subscriptionCost(amount, cadence) {
  const a = Number(amount);
  if (cadence === 'weekly') return { monthlyCost: round2((a * 52) / 12), annualCost: round2(a * 52) };
  if (cadence === 'annual') return { monthlyCost: round2(a / 12), annualCost: round2(a) };
  return { monthlyCost: round2(a), annualCost: round2(a * 12) };
}

/**
 * A subscription Alex marked himself (tracked, never auto-logged). FAILS CLOSED:
 * only an explicit `false` counts, so a row read without its `auto_log` column is
 * never mistaken for one — and so can never be removed or hand-edited as one.
 */
export function isTracked(r) {
  return r?.auto_log === false;
}

/**
 * The next expected charge: the last one plus one cycle of days. The same rule
 * detected subscriptions use (lib/subscriptions.js imports this). Null when
 * nothing is attached — computing from null would throw and 500 the whole page.
 */
export function nextExpectedFrom(lastCharged, cadence) {
  if (!lastCharged) return null;
  return addDaysISO(lastCharged, CADENCE_DAYS[cadence] ?? CADENCE_DAYS.monthly);
}

/** The /subscriptions row key for a manually-marked recurrence. */
export function manualMerchantKey(recurrenceId) {
  return `manual:${recurrenceId}`;
}

/** Day-of-month (UTC) from an ISO date or timestamptz string. */
export function utcDayOfMonth(isoOrTimestamp) {
  return new Date(isoOrTimestamp).getUTCDate();
}
