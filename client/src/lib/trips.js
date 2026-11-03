// Phase 18 — client half of trips: the date rules Quick Add and the row chips need
// before a save, plus Quick Add's trip decisions as plain functions.
//
// server/lib/trips.js is the source of truth; stopForDate, tripForDate and cityOf
// mirror it, on the GET /api/trips payload (camelCase). The total order on both
// sides: latest start, then shortest span, then earliest created, then id.
// test/tripsParity.test.js runs the same cases against both, so this file must stay
// free of `@/` imports.

function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function span(row) {
  return dayNumber(row.endDate) - dayNumber(row.startDate);
}

function byTotalOrder(a, b) {
  if (a.startDate !== b.startDate) return a.startDate > b.startDate ? -1 : 1;
  const shorter = span(a) - span(b);
  if (shorter !== 0) return shorter;
  const created = (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
  if (created !== 0) return created;
  if (a.id === b.id) return 0;
  return String(a.id) < String(b.id) ? -1 : 1;
}

function firstCovering(rows, date) {
  return rows.filter((r) => r.startDate <= date && date <= r.endDate).sort(byTotalOrder)[0] ?? null;
}

/** The stop a date falls in, or null. */
export function stopForDate(stops, date) {
  return firstCovering(stops, date);
}

/** The non-archived trip a date falls in, or null. */
export function tripForDate(trips, date) {
  return firstCovering(trips.filter((t) => !t.archivedAt), date);
}

/** A transaction row's city: its override if set, else its date's stop, else null. */
export function cityOf(tx, stops) {
  if (tx.trip_stop_id) {
    const chosen = stops.find((s) => s.id === tx.trip_stop_id);
    if (chosen) return chosen;
  }
  return stopForDate(stops, tx.date);
}

/** "✈️ Italy · Rome", or "✈️ Italy" with no city. */
export function tripLabel(tripName, stopName) {
  return stopName ? `✈️ ${tripName} · ${stopName}` : `✈️ ${tripName}`;
}

/**
 * What Quick Add's tag shows for the current form, or null for no tag.
 *
 * `choice` is what Alex did by hand in this entry, and it always wins:
 * `{ none: true }` for ✕ or "Not part of this trip", `{ tripId, stopId? }` from the
 * chooser or the Trip picker. `presetTripId` comes from a trip's own page and holds
 * whatever the date. Otherwise the date decides. Income never carries a trip.
 */
export function tagFor({ trips, date, type, presetTripId = null, choice = null }) {
  if (type === 'income' || !trips?.length) return null;
  if (choice?.none) return null;

  const wantedId = choice?.tripId ?? presetTripId;
  const trip = wantedId ? trips.find((t) => t.id === wantedId) : tripForDate(trips, date);
  if (!trip) return null;

  const stops = trip.stops ?? [];
  const derived = stopForDate(stops, date);
  const chosen = choice?.stopId ? stops.find((s) => s.id === choice.stopId) : null;
  const stop = chosen ?? derived;
  return { trip, stop, stopIsOverride: Boolean(chosen) && chosen.id !== derived?.id };
}

/**
 * The trip fields for a create, in one place for both submit paths. `isSpecial` and
 * `specialGroupId` are never in here: while a trip is attached the server derives the
 * star and clears any group. A derived stop is not sent, because storing it would
 * freeze the city against a later correction of the stop's dates.
 */
export function tripSubmitFields(tag) {
  if (!tag) return {};
  return tag.stopIsOverride
    ? { tripId: tag.trip.id, tripStopId: tag.stop.id }
    : { tripId: tag.trip.id };
}

/**
 * The currency the tag wants selected, or null to leave it alone.
 *
 * Never changes a currency Alex picked, and never changes the currency under a typed
 * amount or an armed chip: switching then would turn 4,500 forints into £4,500 (the
 * Phase 12 bug class). `declined` is set for this entry when a failed rate fetch has
 * already switched back to home, so seeding can't loop on it.
 */
export function seedCurrency({ stop, base, amountTyped, armed, currencyTouched, declined }) {
  if (amountTyped || armed || currencyTouched) return null;
  const wanted = stop?.currency ?? base;
  if (declined && wanted !== base) return null;
  return wanted;
}

/** After a failed rate fetch: may Quick Add switch back to home currency? */
export function mayRevertCurrency({ amountTyped, armed }) {
  return !amountTyped && !armed;
}

/**
 * What the Special box should show after the Edit dialog's trip picker changes, which
 * is what the server will do (lib/tripRules.js) if Alex doesn't touch the box himself.
 * Going back to the stored trip means no change at all.
 */
export function starAfterTripChange({ storedTripId, nextTripId, storedSpecial, trips }) {
  if ((nextTripId ?? null) === (storedTripId ?? null)) return !!storedSpecial;
  const find = (id) => trips.find((t) => t.id === id);
  if (nextTripId && find(nextTripId)?.keepOutOfMonthly) return true;
  if (storedTripId && find(storedTripId)?.keepOutOfMonthly) return false;
  return !!storedSpecial;
}

/**
 * The stop field for an edit: nothing unless the override really changes. Choosing the
 * date's own stop means "no override", because storing it would freeze the city.
 */
export function stopFieldFor({ storedTripId, storedStopId, nextTripId, choice, derivedId }) {
  const wanted = choice && choice !== derivedId ? choice : null;
  const stored = (nextTripId ?? null) === (storedTripId ?? null) ? storedStopId ?? null : null;
  return wanted === stored ? {} : { tripStopId: wanted };
}

// --- remembered rates ---------------------------------------------------------------
//
// So the stop's currency works on day 1 of a day abroad with bad signal. A browser
// convenience, so every read and write survives storage being unavailable.

const RATE_KEY = 'trim:fx-rates';
const RATE_MAX_AGE_DAYS = 30;

/** A remembered rate if it is within the last 30 days, else null. */
export function freshRate(entry, today) {
  if (!entry || !(entry.rate > 0) || !entry.date) return null;
  const age = dayNumber(today) - dayNumber(entry.date);
  return age >= 0 && age <= RATE_MAX_AGE_DAYS ? entry : null;
}

export function recallRate(from, to, today) {
  try {
    const all = JSON.parse(localStorage.getItem(RATE_KEY) ?? '{}');
    return freshRate(all[`${from}->${to}`], today);
  } catch {
    return null;
  }
}

export function rememberRate(from, to, rate, date) {
  try {
    const all = JSON.parse(localStorage.getItem(RATE_KEY) ?? '{}');
    all[`${from}->${to}`] = { rate, date };
    localStorage.setItem(RATE_KEY, JSON.stringify(all));
  } catch {
    // Only a convenience: without it the normal "Getting today's rate" gate applies.
  }
}

/** At most two for the Dashboard: on now first, then starting within 7 days, soonest first. */
export function dashboardTrips(trips) {
  const live = trips.filter((t) => !t.archivedAt);
  const onNow = live.filter((t) => t.status === 'active');
  const soon = live
    .filter((t) => t.status === 'upcoming' && t.daysUntilStart <= 7)
    .sort((a, b) => a.daysUntilStart - b.daysUntilStart);
  return [...onNow, ...soon].slice(0, 2);
}

/** "12 Oct – 19 Oct 2026", or one date for a single-day trip. */
export function tripDates(startDate, endDate) {
  const show = (iso, withYear) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  });
  if (startDate === endDate) return show(endDate, true);
  const sameYear = startDate.slice(0, 4) === endDate.slice(0, 4);
  return `${show(startDate, !sameYear)} – ${show(endDate, true)}`;
}
