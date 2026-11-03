// Phase 18 — what a transaction create or update means for its trip, in one place.
//
// Pure, so routes/transactions.js and scripts/devMock.js run the SAME rules
// (BUGS-FIXED shape #2) and each only supplies its own reads. Every rule is judged on
// the RESULTING state of the row, never on one request field: that is the 2026-09-23
// lesson about guards gated on the wrong condition.
//
// Only the trip decides the star, and only when the trip actually changes:
//   joining a keep-out trip              -> starred
//   joining a keep-out-off trip          -> the star is left as it is
//   leaving a keep-out trip              -> un-starred (cleared, or moved to keep-out-off)
//   re-sending the same trip             -> nothing, so a typo fix can't flip a hand-set star
//   an explicit isSpecial                -> always wins
import { stopForDate } from './trips.js';

const refuse = (status, error) => ({ status, error });

/**
 * @param {object} args
 * @param {object|null} args.existing  the stored row; null on a create
 * @param {string|null|undefined} args.tripId  undefined leaves the trip alone; null clears it
 * @param {string|null|undefined} args.tripStopId  an explicit city override
 * @param {boolean|undefined} args.isSpecial
 * @param {string|null|undefined} args.specialGroupId
 * @param {string} args.type  the resulting type
 * @param {string} args.date  the resulting date
 * @param {boolean} [args.recurring]  a create that also opts in to "Repeat this"
 * @param {object|null} [args.oldTrip]  the stored trip's row
 * @param {object|null} [args.newTrip]  the sent trip's row, null if it isn't this user's
 * @param {object[]} [args.stops]  the resulting trip's stops, when a stop was sent
 * @returns {{status: number, error: string} | {fields: object}} the columns to write
 */
export function deriveTripWrite({
  existing, tripId, tripStopId, isSpecial, specialGroupId, type, date, recurring = false,
  oldTrip = null, newTrip = null, stops = [],
}) {
  const storedTrip = existing?.trip_id ?? null;
  const resultingTrip = tripId !== undefined ? tripId : storedTrip;
  const changed = resultingTrip !== storedTrip;

  if (tripId && !newTrip) return refuse(404, 'Trip not found');
  if (resultingTrip && type !== 'expense') return refuse(400, 'Only expenses can be on a trip');
  if (changed && resultingTrip && (recurring || existing?.recurrence_id)) {
    return refuse(400, 'A subscription or repeating charge can’t be on a trip');
  }
  if (resultingTrip && specialGroupId) {
    return refuse(400, 'An expense can be on a trip or in a special group, not both');
  }
  if (tripStopId && !resultingTrip) return refuse(400, 'A city needs a trip');

  const fields = {};
  if (tripId !== undefined) fields.trip_id = tripId;

  if (tripStopId) {
    const stop = stops.find((s) => s.id === tripStopId);
    if (!stop) return refuse(400, 'That city is not on this trip');
    // The date's own stop is just the derived city. Storing it would freeze it, so a
    // later correction of the stop's dates wouldn't move the expense.
    fields.trip_stop_id = stopForDate(stops, date)?.id === stop.id ? null : stop.id;
  } else if (tripStopId === null || changed) {
    fields.trip_stop_id = null;
  }

  if (isSpecial === undefined && changed) {
    if (newTrip?.keep_out_of_monthly) fields.is_special = true;
    else if (oldTrip?.keep_out_of_monthly) fields.is_special = false;
  }

  // Setting a trip clears any group, so the database's trip-XOR-group CHECK can't be hit.
  if (changed && resultingTrip && specialGroupId === undefined) fields.special_group_id = null;

  return { fields };
}
