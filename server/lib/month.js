// "Which day and month is it — for THIS user?"
//
// Every period boundary in the app used to be computed from the server's UTC
// clock, in three separate copies of `monthBounds` plus a dozen ad-hoc
// `getUTCMonth()` calls. That is wrong for anyone not on UTC: a user in Paris
// logging at 00:30 on the 1st is in a new month while the server is still in the
// old one, so their fresh transaction vanished from "this month" until 02:00
// local. Alex hit this travelling; it is about an hour a day in London BST and
// two in CEST.
//
// Everything here is derived from ONE zone-local calendar day and then handled
// as plain strings. `transactions.date` is a DATE column compared as text, so
// string arithmetic is not a shortcut — it is the representation that matches
// the data, and it cannot drift the way Date objects do.

/** Fallback when a user has no timezone stored yet (older accounts). */
export const DEFAULT_TIMEZONE = 'UTC';

// en-CA formats as YYYY-MM-DD, which is exactly the shape the date column uses.
// Node 20+ ships full ICU, so named zones resolve without extra data.
function formatInZone(timeZone, date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * The user's local calendar day as 'YYYY-MM-DD'.
 * An unknown or malformed zone falls back to UTC rather than throwing — a bad
 * preference must never take the whole dashboard down.
 */
export function dayInZone(timeZone, date = new Date()) {
  try {
    return formatInZone(timeZone || DEFAULT_TIMEZONE, date);
  } catch {
    return formatInZone(DEFAULT_TIMEZONE, date);
  }
}

/** The user's local calendar month as 'YYYY-MM'. */
export function ymInZone(timeZone, date = new Date()) {
  return dayInZone(timeZone, date).slice(0, 7);
}

/** 'YYYY-MM' + n months. Pure string arithmetic; no clock, no Date. */
export function addMonths(ym, delta) {
  const [year, month] = ym.split('-').map(Number);
  const zeroBased = year * 12 + (month - 1) + delta;
  const y = Math.floor(zeroBased / 12);
  const m = zeroBased - y * 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/** Days in a 'YYYY-MM'. Date.UTC with day 0 gives the last day of month m. */
export function daysInMonth(ym) {
  const [year, month] = ym.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day-of-month from a 'YYYY-MM-DD'. */
export function dayOfMonth(iso) {
  return Number(iso.slice(8, 10));
}

/**
 * Half-open bounds for the user's current month: `date >= firstISO` and
 * `date < nextFirstISO`, matching how every route already queries.
 */
export function monthBounds(timeZone, date = new Date()) {
  const ym = ymInZone(timeZone, date);
  return { ym, firstISO: `${ym}-01`, nextFirstISO: `${addMonths(ym, 1)}-01` };
}
