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

// A line with no stop_id is for the whole trip; one with a stop_id is that city's.
const isTripLine = (b) => b.stop_id == null;

/** Budgeted categories first, in the order given, then any other spending, biggest first. */
function categoryBars(lines, spentByCategory) {
  const budgeted = new Set(lines.map((b) => b.category_id));
  const other = [...spentByCategory].filter(([categoryId]) => !budgeted.has(categoryId));
  return {
    byCategory: [
      ...lines.map((b) => ({
        categoryId: b.category_id,
        limit: Number(b.amount_limit),
        spent: fromCents(spentByCategory.get(b.category_id) ?? 0),
      })),
      ...other
        .map(([categoryId, cents]) => ({ categoryId, limit: null, spent: fromCents(cents) }))
        .sort((a, b) => b.spent - a.spent),
    ],
    otherCategoriesSpent: fromCents(other.reduce((sum, [, cents]) => sum + cents, 0)),
  };
}

/**
 * Every figure for one trip. `txs` are the trip's expenses; amounts may be decoded
 * strings. `categoryBudgets` may hold city lines (a `stop_id`) as well as whole-trip
 * ones; city lines are counted only while the trip's switch is on, and are kept, unused,
 * while it's off. `remaining` is floored at 0 and `overBy` carries the excess. `perDayLeft`
 * is non-null only while active and budgeted: what is left divided by the days left,
 * including today. It is deliberately not the monthly pace comparison, because
 * pre-paid flights and hotels would read as "over pace" on day 1.
 */
export function summariseTrip(trip, stops, categoryBudgets, txs, today) {
  const stopCents = new Map(stops.map((s) => [s.id, 0]));
  const stopCategoryCents = new Map(stops.map((s) => [s.id, new Map()]));
  const categoryCents = new Map();
  let spentCents = 0;
  let noCityCents = 0;

  for (const tx of txs) {
    const cents = toCents(tx.amount);
    spentCents += cents;

    const categoryId = tx.category_id ?? null;
    categoryCents.set(categoryId, (categoryCents.get(categoryId) ?? 0) + cents);

    const city = cityOf(tx, stops);
    if (city) {
      stopCents.set(city.id, stopCents.get(city.id) + cents);
      const inCity = stopCategoryCents.get(city.id);
      inCity.set(categoryId, (inCity.get(categoryId) ?? 0) + cents);
    } else {
      noCityCents += cents;
    }
  }

  const whole = categoryBars(categoryBudgets.filter(isTripLine), categoryCents);
  const byCity = !!trip.city_category_budgets;

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
    byCategory: whole.byCategory,
    otherCategoriesSpent: whole.otherCategoriesSpent,
    byStop: stops.map((s) => {
      const city = byCity
        ? categoryBars(categoryBudgets.filter((b) => b.stop_id === s.id), stopCategoryCents.get(s.id))
        : null;
      return {
        stopId: s.id,
        budget: s.budget == null ? null : Number(s.budget),
        spent: fromCents(stopCents.get(s.id)),
        // Only while the switch is on: null says "not budgeting this city by category".
        byCategory: city?.byCategory ?? null,
        otherCategoriesSpent: city?.otherCategoriesSpent ?? null,
      };
    }),
    noCitySpent: fromCents(noCityCents),
    count: txs.length,
  };
}

/**
 * One trip as the API shows it, built field by field so no ciphertext, `user_id` or
 * other column the codec added can reach the browser. Used by routes/trips.js and
 * devMock alike. `createdAt` is here because the client's total order needs it.
 */
export function presentTrip(trip, stops, categoryBudgets, summary, today) {
  const { status, daysUntilStart, dayOfTrip, length, daysLeft } = tripStatus(trip, today);
  return {
    id: trip.id,
    name: trip.name,
    startDate: trip.start_date,
    endDate: trip.end_date,
    keepOutOfMonthly: trip.keep_out_of_monthly,
    cityCategoryBudgets: !!trip.city_category_budgets,
    sourceGroupId: trip.source_group_id ?? null,
    archivedAt: trip.archived_at ?? null,
    createdAt: trip.created_at,
    status,
    daysUntilStart,
    dayOfTrip,
    length,
    daysLeft,
    totalBudget: summary.totalBudget,
    spent: summary.spent,
    remaining: summary.remaining,
    perDayLeft: summary.perDayLeft,
    overBy: summary.overBy,
    count: summary.count,
    stops: stops.map((s) => ({
      id: s.id,
      name: s.name,
      startDate: s.start_date,
      endDate: s.end_date,
      budget: s.budget == null ? null : Number(s.budget),
      currency: s.currency ?? null,
      createdAt: s.created_at,
      // Always sent, even with the switch off, so switching it back on shows them again.
      categoryBudgets: categoryBudgets.filter((b) => b.stop_id === s.id).map(presentLine),
    })),
    categoryBudgets: categoryBudgets.filter(isTripLine).map(presentLine),
  };
}

function presentLine(b) {
  return { id: b.id, categoryId: b.category_id, amount: Number(b.amount_limit) };
}

// Rows are stored under the trip's id, so one read can feed every trip.
export function groupByTrip(rows) {
  const out = new Map();
  for (const row of rows) {
    if (!out.has(row.trip_id)) out.set(row.trip_id, []);
    out.get(row.trip_id).push(row);
  }
  return out;
}

const UNTAGGED_LIMIT = 200;

/** Newest first, then filtered by `q` on the note, in the two lists "Add expenses" shows. */
export function splitUntagged(rows, trip, q) {
  // Express hands back an array for ?q=a&q=b.
  const needle = (typeof q === 'string' ? q : '').trim().toLowerCase();
  const shown = rows
    .filter((r) => !needle || (r.description ?? '').toLowerCase().includes(needle))
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1));
  return {
    during: shown.filter((r) => r.date >= trip.start_date).slice(0, UNTAGGED_LIMIT),
    before: shown.filter((r) => r.date < trip.start_date).slice(0, UNTAGGED_LIMIT),
  };
}

/** The earliest date "Before the trip" reaches: 180 days before the start. */
export function untaggedWindowStart(trip) {
  const start = new Date(`${trip.start_date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 180);
  return start.toISOString().slice(0, 10);
}
