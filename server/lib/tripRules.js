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
import { z } from 'zod';
import { stopForDate } from './trips.js';
import { QUOTABLE_CURRENCIES } from './fx.js';

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

// --- the trip editor's one save ---------------------------------------------------

// Everything below refuses what PostgreSQL would refuse, BEFORE anything is written. A save
// writes in steps, so a value the database turns down at the last step left a half-applied
// trip that no retry could finish (BUGS-FIXED 2026-11-18).
const MAX_MONEY = 1_000_000_000;
// Whole pence and at least 0.01: numeric(14,2) rounds 0.004 to 0.00, which breaks `> 0`.
const money = z.number().finite().max(MAX_MONEY)
  .refine((v) => v >= 0.01 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At least 0.01, in whole pence');
// PostgreSQL text can't hold U+0000, and a name has no use for any control character.
const tripName = z.string().trim().min(1).max(60)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'No control characters');

// A real calendar day: a bare regex would let "2026-13-45" reach Postgres as a 500, and
// PostgreSQL has no year 0000.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine((v) => {
  const parsed = new Date(`${v}T00:00:00Z`);
  const year = Number(v.slice(0, 4));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v
    && year >= 1900 && year <= 2999;
}, 'Not a real date');

// Every city line is a statement in a save. Capped well above real use, so one request
// can't run hundreds of writes one after another.
const MAX_CITY_LINES = 100;
const cityLineCount = (d) => (d.stops ?? []).reduce((n, s) => n + (s.categoryBudgets?.length ?? 0), 0);
const fewCityLines = [(d) => cityLineCount(d) <= MAX_CITY_LINES, { message: `At most ${MAX_CITY_LINES} city budget lines in one trip` }];

const categoryBudgetSchema = z.object({
  categoryId: z.string().uuid(),
  amount: money,
});

const stopSchema = z.object({
  id: z.string().uuid().optional(),
  name: tripName,
  startDate: day,
  endDate: day,
  budget: money.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  // This city's own category lines, nested because a new stop has no id yet. Absent leaves
  // a kept stop's lines as they are (the editor omits them in Simple mode, or with the
  // switch off); present is the full desired list for that city.
  categoryBudgets: z.array(categoryBudgetSchema).max(30).optional(),
});

export const tripCreateSchema = z.object({
  name: tripName,
  startDate: day,
  endDate: day,
  totalBudget: money.nullable().optional(),
  keepOutOfMonthly: z.boolean().default(true),
  cityCategoryBudgets: z.boolean().default(false),
  stops: z.array(stopSchema).max(30).default([]),
  categoryBudgets: z.array(categoryBudgetSchema).max(60).default([]),
}).refine(...fewCityLines);

export const tripPatchSchema = z.object({
  name: tripName.optional(),
  startDate: day.optional(),
  endDate: day.optional(),
  totalBudget: money.nullable().optional(),
  keepOutOfMonthly: z.boolean().optional(),
  cityCategoryBudgets: z.boolean().optional(),
  archived: z.boolean().optional(),
  // When present these are the FULL desired lists, validated with the new dates.
  stops: z.array(stopSchema).max(30).optional(),
  categoryBudgets: z.array(categoryBudgetSchema).max(60).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update' }).refine(...fewCityLines);

export const fromGroupSchema = z.object({
  groupId: z.string().uuid(),
  trip: tripCreateSchema,
});

export const bulkAddSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(100),
});

export const DELETE_MODES = ['count', 'keep', 'restore'];

/**
 * Everything about one save that needs no database: dates together, stops inside the
 * trip, one budget per category. Overlapping stops are allowed; the total order decides.
 * `baseCurrency` is omitted when the stops weren't sent, so an untouched stop isn't
 * re-judged. Returns a refusal, or null when the plan is fine.
 */
export function checkTripPlan({ startDate, endDate, stops = [], categoryBudgets = [], baseCurrency = null }) {
  if (endDate < startDate) return refuse(400, 'A trip can’t end before it starts');
  for (const stop of stops) {
    if (stop.endDate < stop.startDate) return refuse(400, `${stop.name} can’t end before it starts`);
    if (stop.startDate < startDate || stop.endDate > endDate) {
      return refuse(400, `${stop.name} has to sit inside the trip’s dates`);
    }
    if (baseCurrency && stop.currency && stop.currency !== baseCurrency && !QUOTABLE_CURRENCIES.includes(stop.currency)) {
      return refuse(400, `Trim can’t get a rate for ${stop.currency}`);
    }
  }
  const seen = new Set();
  for (const { categoryId } of categoryBudgets) {
    if (seen.has(categoryId)) return refuse(409, 'That category already has a budget on this trip');
    seen.add(categoryId);
  }
  for (const stop of stops) {
    const inCity = new Set();
    for (const { categoryId } of stop.categoryBudgets ?? []) {
      if (inCity.has(categoryId)) return refuse(409, `That category already has a budget in ${stop.name}`);
      inCity.add(categoryId);
    }
  }
  return null;
}

/** Every category line in a save, whole-trip and city alike: the ones to ownership-check. */
export function allCategoryLines(body) {
  return [
    ...(body.categoryBudgets ?? []),
    ...(body.stops ?? []).flatMap((s) => s.categoryBudgets ?? []),
  ];
}

/** Every budgeted category must be one of this user's expense categories. */
export function checkTripCategories(categoryBudgets, ownedCategories) {
  for (const { categoryId } of categoryBudgets) {
    const owned = ownedCategories.find((c) => c.id === categoryId);
    if (!owned) return refuse(404, 'Category not found');
    if (owned.type !== 'expense') return refuse(400, 'Trip budgets are for expense categories');
  }
  return null;
}

const nullable = (v) => (v === undefined ? null : v);

/** A stop from the request as stored columns (without user_id and trip_id). */
export function stopRow(stop) {
  return {
    name: stop.name,
    start_date: stop.startDate,
    end_date: stop.endDate,
    budget: nullable(stop.budget),
    currency: nullable(stop.currency),
  };
}

/**
 * Compare the stored stops with the full desired list. An id must belong to this trip,
 * no id means new, a missing id is removed, so tagged expenses keep their stop.
 */
export function diffStops(existing, desired) {
  const known = new Set(existing.map((s) => s.id));
  const kept = new Set();
  for (const stop of desired) {
    if (!stop.id) continue;
    if (!known.has(stop.id)) return refuse(404, 'Stop not found');
    if (kept.has(stop.id)) return refuse(400, 'The same stop appears twice');
    kept.add(stop.id);
  }
  const same = (row, next) =>
    row.name === next.name && row.start_date === next.start_date && row.end_date === next.end_date
    && nullable(row.currency) === next.currency
    && (row.budget == null ? null : Number(row.budget)) === next.budget;
  return {
    removedIds: existing.filter((s) => !kept.has(s.id)).map((s) => s.id),
    toUpdate: desired
      .filter((stop) => stop.id && !same(existing.find((s) => s.id === stop.id), stopRow(stop)))
      .map((stop) => ({ id: stop.id, row: stopRow(stop) })),
    toInsert: desired.filter((stop) => !stop.id).map(stopRow),
  };
}

/**
 * Compare by category, not by row id: swapping two lines is then just two amount
 * updates, and the unique (trip, category) constraint can never trip midway.
 */
export function diffCategoryBudgets(existing, desired) {
  // Whole-trip lines only. City lines are diffed per stop by diffCityBudgets.
  existing = existing.filter((b) => b.stop_id == null);
  const stored = new Map(existing.map((b) => [b.category_id, b]));
  const wanted = new Set(desired.map((b) => b.categoryId));
  return {
    removedCategoryIds: existing.filter((b) => !wanted.has(b.category_id)).map((b) => b.category_id),
    toUpdate: desired
      .filter((b) => stored.has(b.categoryId) && Number(stored.get(b.categoryId).amount_limit) !== b.amount)
      .map((b) => ({ id: stored.get(b.categoryId).id, amount_limit: b.amount })),
    toInsert: desired
      .filter((b) => !stored.has(b.categoryId))
      .map((b) => ({ category_id: b.categoryId, amount_limit: b.amount })),
  };
}

/**
 * City lines for the stops a save KEEPS and sent lines for, compared by category within
 * each city. Removed stops' lines go with the stop; a new stop's lines are inserted after
 * it, once it has an id.
 */
export function diffCityBudgets(existing, desiredStops) {
  const removedIds = [];
  const toUpdate = [];
  const toInsert = [];
  for (const stop of desiredStops) {
    if (!stop.id || !stop.categoryBudgets) continue;
    const stored = new Map(existing.filter((b) => b.stop_id === stop.id).map((b) => [b.category_id, b]));
    const wanted = new Set(stop.categoryBudgets.map((b) => b.categoryId));
    for (const [categoryId, b] of stored) if (!wanted.has(categoryId)) removedIds.push(b.id);
    for (const b of stop.categoryBudgets) {
      const had = stored.get(b.categoryId);
      if (!had) toInsert.push({ stop_id: stop.id, category_id: b.categoryId, amount_limit: b.amount });
      else if (Number(had.amount_limit) !== b.amount) toUpdate.push({ id: had.id, amount_limit: b.amount });
    }
  }
  return { removedIds, toUpdate, toInsert };
}

/** A new stop's own lines, ready to insert once the stop exists. */
export function cityLinesFor(stop, stopId) {
  return (stop.categoryBudgets ?? []).map((b) => ({ stop_id: stopId, category_id: b.categoryId, amount_limit: b.amount }));
}
