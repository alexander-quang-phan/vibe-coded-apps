// Phase 18 — trips. The one home of every trip date rule and trip figure.
//
// Pure and DB-free, for the same reason as lib/overallBudget.js: the routes and
// devMock all call this, so a figure can't be worked out two ways. Rows are the
// decoded database shape (snake_case). client/src/lib/trips.js mirrors stopForDate,
// tripForDate and cityOf; this file is the source of truth, and
// test/tripsParity.test.js runs the same cases against both.
//
// Membership is stored (transactions.trip_id); the city is derived from the date
// every time, and trip_stop_id is only ever an explicit override. A trip figure
// counts every expense on the trip, starred or not, pre-trip bookings included.

const MS_PER_DAY = 86_400_000;

function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function daysBetween(fromIso, toIso) {
  return dayNumber(toIso) - dayNumber(fromIso);
}

// Summing whole cents, so city and category totals add up to `spent` exactly.
function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

function fromCents(cents) {
  return cents / 100;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Where a trip stands on `today` (the user's own calendar day, 'YYYY-MM-DD').
 * All day counts are inclusive. A field is non-null only where it means something:
 * daysUntilStart while upcoming, dayOfTrip and daysLeft while active.
 */
export function tripStatus(trip, today) {
  const length = daysBetween(trip.start_date, trip.end_date) + 1;
  if (today < trip.start_date) {
    return {
      status: 'upcoming',
      daysUntilStart: daysBetween(today, trip.start_date),
      dayOfTrip: null,
      length,
      daysLeft: null,
    };
  }
  if (today > trip.end_date) {
    return { status: 'past', daysUntilStart: null, dayOfTrip: null, length, daysLeft: null };
  }
  return {
    status: 'active',
    daysUntilStart: null,
    dayOfTrip: daysBetween(trip.start_date, today) + 1,
    length,
    daysLeft: daysBetween(today, trip.end_date) + 1,
  };
}

// The total order for overlapping dates: latest start, then shortest span, then
// earliest created, then id. A day trip "Pompeii 12-12" inside "Rome 12-15"
// therefore wins on the 12th. Overlaps are allowed; this always decides.
function byTotalOrder(a, b) {
  if (a.start_date !== b.start_date) return a.start_date > b.start_date ? -1 : 1;
  const span = daysBetween(a.start_date, a.end_date) - daysBetween(b.start_date, b.end_date);
  if (span !== 0) return span;
  const created = (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0);
  if (created !== 0) return created;
  if (a.id === b.id) return 0;
  return String(a.id) < String(b.id) ? -1 : 1;
}

function firstCovering(rows, date) {
  return rows.filter((r) => r.start_date <= date && date <= r.end_date).sort(byTotalOrder)[0] ?? null;
}

/** The stop a date falls in, or null. */
export function stopForDate(stops, date) {
  return firstCovering(stops, date);
}

/** The non-archived trip a date falls in, or null. */
export function tripForDate(trips, date) {
  return firstCovering(trips.filter((t) => !t.archived_at), date);
}

/** A transaction's city: the override if one is set, else its date's stop, else null ("No city"). */
export function cityOf(tx, stops) {
  if (tx.trip_stop_id) {
    const chosen = stops.find((s) => s.id === tx.trip_stop_id);
    if (chosen) return chosen;
  }
  return stopForDate(stops, tx.date);
}

/**
 * Every figure for one trip. `txs` are the trip's expenses; amounts may be decoded
 * strings. `remaining` is floored at 0 and `overBy` carries the excess. `perDayLeft`
 * is non-null only while active and budgeted: what is left divided by the days left,
 * including today. It is deliberately not the monthly pace comparison, because
 * pre-paid flights and hotels would read as "over pace" on day 1.
 */
export function summariseTrip(trip, stops, categoryBudgets, txs, today) {
  const stopCents = new Map(stops.map((s) => [s.id, 0]));
  const categoryCents = new Map();
  let spentCents = 0;
  let noCityCents = 0;

  for (const tx of txs) {
    const cents = toCents(tx.amount);
    spentCents += cents;

    const categoryId = tx.category_id ?? null;
    categoryCents.set(categoryId, (categoryCents.get(categoryId) ?? 0) + cents);

    const city = cityOf(tx, stops);
    if (city) stopCents.set(city.id, stopCents.get(city.id) + cents);
    else noCityCents += cents;
  }

  const budgetedIds = new Set(categoryBudgets.map((b) => b.category_id));
  const unbudgeted = [...categoryCents]
    .filter(([categoryId]) => !budgetedIds.has(categoryId))
    .map(([categoryId, cents]) => ({ categoryId, limit: null, spent: fromCents(cents) }))
    .sort((a, b) => b.spent - a.spent);
  const otherCents = [...categoryCents]
    .filter(([categoryId]) => !budgetedIds.has(categoryId))
    .reduce((sum, [, cents]) => sum + cents, 0);

  const spent = fromCents(spentCents);
  const totalBudget = trip.total_budget == null ? null : Number(trip.total_budget);
  const left = totalBudget === null ? null : totalBudget - spent;
  const { status, daysLeft } = tripStatus(trip, today);

  return {
    spent,
    totalBudget,
    remaining: left === null ? null : round2(Math.max(left, 0)),
    perDayLeft:
      left !== null && status === 'active' ? round2(Math.max(left, 0) / daysLeft) : null,
    overBy: left !== null && left < 0 ? round2(-left) : 0,
    byCategory: [
      ...categoryBudgets.map((b) => ({
        categoryId: b.category_id,
        limit: Number(b.amount_limit),
        spent: fromCents(categoryCents.get(b.category_id) ?? 0),
      })),
      ...unbudgeted,
    ],
    otherCategoriesSpent: fromCents(otherCents),
    byStop: stops.map((s) => ({
      stopId: s.id,
      budget: s.budget == null ? null : Number(s.budget),
      spent: fromCents(stopCents.get(s.id)),
    })),
    noCitySpent: fromCents(noCityCents),
    count: txs.length,
  };
}
