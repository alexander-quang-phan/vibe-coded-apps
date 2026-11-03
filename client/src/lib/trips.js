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
