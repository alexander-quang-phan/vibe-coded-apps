/**
 * The trips route, over real HTTP against a fake database, once per phase.
 *
 * Trips have five encrypted fields across three tables, and every figure is computed
 * in JS after decoding, so a route that forgets to decode one query gives NaN rather
 * than an error. Each phase must give the same JSON.
 *
 * The fake has no CHECKs, foreign keys or cascades. test/trips.pg.test.js covers those.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const FOOD = '11111111-1111-4111-8111-111111111111';
const FUN = '11111111-1111-4111-8111-111111111112';
const SALARY = '11111111-1111-4111-8111-111111111113';
const THEIR_CAT = '11111111-1111-4111-8111-111111111114';
const ITALY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const THEIR_TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const PAST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const ROME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const NAPLES = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const THEIR_STOP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const LISBON = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const THEIR_GROUP = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const REC = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const tid = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function seed(phase, { specialOn = false } = {}) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  const trip = (id, user_id, name, total_budget, start_date, end_date, extra = {}) => ({
    id, user_id, start_date, end_date, keep_out_of_monthly: true, archived_at: null,
    source_group_id: null, created_at: '2026-10-01T10:00:00Z', ...extra,
    ...encodeWrite('trips', user_id, { name, total_budget }, phase),
  });
  const stop = (id, user_id, trip_id, name, start_date, end_date, budget, currency) => ({
    id, user_id, trip_id, start_date, end_date, currency, created_at: '2026-10-01T10:00:00Z',
    ...encodeWrite('trip_stops', user_id, { name, budget }, phase),
  });
  const tx = (n, amount, date, description, extra = {}) => ({
    id: tid(n), user_id: U, category_id: FOOD, type: 'expense', date, is_special: false,
    special_group_id: null, is_recurring: false, recurrence_id: null, trip_id: null, trip_stop_id: null,
    original_currency: null, fx_rate: null, created_at: `${date}T10:00:00Z`, ...extra,
    ...encodeWrite('transactions', extra.user_id ?? U, { amount, description, original_amount: null }, phase),
  });
  const cat = (id, user_id, name, type) => ({
    id, user_id, icon: '🍔', color: '#000000', type,
    ...encodeWrite('categories', user_id, { name }, phase),
  });
  const group = (id, user_id, name) => ({
    id, user_id, archived_at: null, created_at: '2026-09-01T10:00:00Z',
    ...encodeWrite('special_groups', user_id, { name }, phase),
  });
  return {
    trips: [
      trip(ITALY, U, 'Italy', 1000, day(-2), day(5)),
      trip(PAST, U, 'Skye', 300, '2026-03-01', '2026-03-05', { keep_out_of_monthly: false }),
      trip(THEIR_TRIP, OTHER, 'Not yours', 50, day(-2), day(5)),
    ],
    trip_stops: [
      stop(NAPLES, U, ITALY, 'Naples', day(2), day(5), null, null),
      stop(ROME, U, ITALY, 'Rome', day(-2), day(1), 500, 'EUR'),
      stop(THEIR_STOP, OTHER, THEIR_TRIP, 'Hidden', day(-2), day(5), null, null),
    ],
    trip_category_budgets: [
      {
        id: 'b1', user_id: U, trip_id: ITALY, category_id: FOOD, created_at: '2026-10-01T10:00:00Z',
        ...encodeWrite('trip_category_budgets', U, { amount_limit: 200 }, phase),
      },
      {
        id: 'b2', user_id: U, trip_id: ITALY, category_id: FUN, created_at: '2026-10-01T10:00:01Z',
        ...encodeWrite('trip_category_budgets', U, { amount_limit: 100 }, phase),
      },
    ],
    transactions: [
      tx(1, 186.4, day(-30), 'Flights', { trip_id: ITALY, is_special: true, category_id: FUN }),
      tx(2, 38.5, day(-1), 'Trattoria', { trip_id: ITALY, is_special: true }),
      tx(3, 64, day(0), 'Belt', { trip_id: ITALY, trip_stop_id: NAPLES, is_special: false }),
      tx(4, 74, '2026-07-01', 'Lisbon flights', { special_group_id: LISBON, is_special: true }),
      tx(5, 42.5, '2026-08-20', 'Lisbon food', { special_group_id: LISBON, is_special: true }),
      tx(6, 3.5, day(-1), 'Coffee Roma'),
      tx(7, 90, day(-40), 'Hotel deposit', { is_special: true }),
      tx(8, 9, day(-400), 'Too old'),
      tx(9, 10.99, day(-1), 'Netflix', { recurrence_id: REC }),
      tx(10, 2000, day(-1), 'Salary', { type: 'income', category_id: SALARY }),
      tx(11, 5, day(-1), 'Their coffee', { user_id: OTHER }),
      tx(12, 12, '2026-03-02', 'Skye ferry', { trip_id: PAST }),
      tx(13, 7, day(-1), 'In a group', { special_group_id: LISBON, is_special: true }),
    ],
    categories: [
      cat(FOOD, U, 'Food', 'expense'),
      cat(FUN, U, 'Fun', 'expense'),
      cat(SALARY, U, 'Salary', 'income'),
      cat(THEIR_CAT, OTHER, 'Theirs', 'expense'),
    ],
    special_groups: [group(LISBON, U, 'Lisbon weekend'), group(THEIR_GROUP, OTHER, 'Theirs')],
    user_stats: [{
      user_id: U, currency: 'GBP', timezone: 'UTC', special_expenses_enabled: specialOn,
      ...encodeWrite('user_stats', U, { monthly_limit: null }, phase),
    }],
  };
}

export function runTripsRouteSuite(phase) {
  const label = `[phase=${phase}]`;

  let currentDb = null;
  let mocked = false;
  const supabaseProxy = {
    from: (t) => currentDb.from(t),
    rpc: (...args) => currentDb.rpc(...args),
  };

  async function boot(tables, opts) {
    const { fakeSupabase, serve } = await import('./routeHarness.js');
    currentDb = fakeSupabase(tables ?? (await seed(phase)), opts);
    if (!mocked) {
      mock.module('../../lib/supabase.js', { exports: { supabase: supabaseProxy } });
      mocked = true;
    }
    const { default: router } = await import('../../routes/trips.js');
    const http = await serve(router, { userId: U, mountAt: '/api/trips' });
    return { db: currentDb, http };
  }

  async function run(fn, { tables, opts } = {}) {
    const { db, http } = await boot(tables, opts);
    try {
      await fn(db, http);
    } finally {
      await http.close();
    }
  }

  const row = (db, n) => db.store.transactions.find((t) => t.id === tid(n));
  const clean = (body) => {
    const json = JSON.stringify(body);
    for (const forbidden of ['_enc', 'v2:', '_hmac', 'user_id', U]) {
      assert.ok(!json.includes(forbidden), `response must not contain ${forbidden}`);
    }
  };
  const newTrip = (over = {}) => ({
    name: 'Spain', startDate: day(10), endDate: day(14), totalBudget: 500, keepOutOfMonthly: false,
    stops: [], categoryBudgets: [], ...over,
  });

  // --- GET / ---------------------------------------------------------------------

  test(`${label} GET / gives every trip of mine with its figures, and leaks nothing`, async () => {
    await run(async (_db, http) => {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(body.trips.map((t) => t.name).sort(), ['Italy', 'Skye']);
      clean(body);

      const italy = body.trips.find((t) => t.id === ITALY);
      assert.equal(italy.status, 'active');
      assert.equal(italy.dayOfTrip, 3);
      assert.equal(italy.length, 8);
      assert.equal(italy.daysLeft, 6);
      assert.equal(italy.totalBudget, 1000);
      assert.equal(italy.spent, 288.9, 'starred or not, pre-trip bookings included');
      assert.equal(italy.remaining, 711.1);
      assert.equal(italy.perDayLeft, 118.52);
      assert.equal(italy.overBy, 0);
      assert.equal(italy.count, 3);
      assert.equal(italy.keepOutOfMonthly, true);
    });
  });

  test(`${label} GET /: trips and stops carry the id and createdAt the client's order needs`, async () => {
    await run(async (_db, http) => {
      const { body } = await http.get('/');
      const italy = body.trips.find((t) => t.id === ITALY);
      assert.equal(italy.createdAt, '2026-10-01T10:00:00Z');
      assert.deepEqual(italy.stops.map((s) => s.name), ['Rome', 'Naples'], 'by start date');
      assert.equal(italy.stops[0].id, ROME);
      assert.equal(italy.stops[0].createdAt, '2026-10-01T10:00:00Z');
      assert.equal(italy.stops[0].budget, 500);
      assert.equal(italy.stops[0].currency, 'EUR');
      assert.equal(italy.stops[1].budget, null);
      assert.deepEqual(italy.categoryBudgets.map((b) => [b.categoryId, b.amount]), [[FOOD, 200], [FUN, 100]]);
    });
  });

  test(`${label} GET / is paged past the database's row cap, with past-trip results present`, async () => {
    await run(async (db, http) => {
      const { body } = await http.get('/');
      const italy = body.trips.find((t) => t.id === ITALY);
      assert.equal(italy.spent, 288.9, 'a silent cut at 2 rows would give a wrong total');
      const skye = body.trips.find((t) => t.id === PAST);
      assert.equal(skye.status, 'past');
      assert.equal(skye.spent, 12);
      assert.equal(skye.remaining, 288, 'came in this much under');
      const paged = db.calls.find((c) => c.table === 'transactions' && c.orders.length === 2);
      assert.deepEqual(paged.orders.map((o) => o.c), ['date', 'id']);
    }, { opts: { maxRows: 2 } });
  });

  // --- GET /:id ------------------------------------------------------------------

  test(`${label} GET /:id gives the full summary and full transaction rows`, async () => {
    await run(async (_db, http) => {
      const { status, body } = await http.get(`/${ITALY}`);
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      assert.equal(body.summary.spent, 288.9);
      assert.equal(body.summary.noCitySpent, 186.4, 'the pre-trip flight');
      assert.deepEqual(
        body.summary.byStop.map((s) => [s.stopId, s.spent]),
        [[ROME, 38.5], [NAPLES, 64]],
      );
      assert.deepEqual(body.summary.byCategory[0], { categoryId: FOOD, limit: 200, spent: 102.5 });
      assert.equal(body.transactions.length, 3);
      const belt = body.transactions.find((t) => t.description === 'Belt');
      assert.equal(belt.amount, 64);
      assert.equal(belt.trip_stop_id, NAPLES);
      assert.equal(belt.is_special, false, 'a full row, which the shared edit dialog needs');
      assert.equal(body.sourceGroup, null);
    });
  });

  test(`${label} GET /:id names the group a trip came from, decoded`, async () => {
    const tables = await seed(phase);
    tables.trips[0].source_group_id = LISBON;
    await run(async (_db, http) => {
      const { body } = await http.get(`/${ITALY}`);
      assert.deepEqual(body.sourceGroup, { id: LISBON, name: 'Lisbon weekend' });
    }, { tables });
  });

  test(`${label} GET /:id: another user's trip and a malformed id are both 404`, async () => {
    await run(async (_db, http) => {
      assert.equal((await http.get(`/${THEIR_TRIP}`)).status, 404);
      assert.equal((await http.get('/not-a-uuid')).status, 404);
    });
  });

  // --- POST / --------------------------------------------------------------------

  test(`${label} POST / creates the trip, stops and budgets, encrypted per phase`, async () => {
    await run(async (db, http) => {
      const { status, body } = await http.send('POST', '/', newTrip({
        stops: [
          { name: 'Madrid', startDate: day(10), endDate: day(12), budget: 200, currency: 'EUR' },
          { name: 'Seville', startDate: day(13), endDate: day(14) },
        ],
        categoryBudgets: [{ categoryId: FOOD, amount: 150 }],
      }));
      assert.equal(status, 201, JSON.stringify(body));
      clean(body);
      assert.equal(body.trip.name, 'Spain');
      assert.equal(body.trip.status, 'upcoming');
      assert.equal(body.trip.daysUntilStart, 10);
      assert.equal(body.trip.stops[0].budget, 200);
      assert.equal(body.trip.categoryBudgets[0].amount, 150);

      const stored = db.store.trips.find((t) => t.id === body.trip.id);
      const stop = db.store.trip_stops.find((s) => s.trip_id === body.trip.id && s.start_date === day(10));
      const line = db.store.trip_category_budgets.find((b) => b.trip_id === body.trip.id);
      assert.equal(stored.user_id, U);
      assert.equal(stop.user_id, U);
      assert.equal(line.user_id, U);
      if (phase === 'off') {
        assert.equal(stored.name, 'Spain');
        assert.equal(stored.name_enc, undefined);
        assert.equal(stop.budget, 200);
        assert.equal(line.amount_limit, 150);
      } else {
        for (const value of [stored.name_enc, stored.total_budget_enc, stop.name_enc, stop.budget_enc, line.amount_limit_enc]) {
          assert.match(String(value), /^v2:/);
        }
        if (phase === 'enc') {
          assert.equal(stored.name, undefined);
          assert.equal(stop.budget, undefined);
          assert.equal(line.amount_limit, undefined);
        }
      }
    });
  });

  test(`${label} POST / refuses bad input with a 400 and writes nothing`, async () => {
    await run(async (db, http) => {
      const before = db.store.trips.length;
      const bad = [
        newTrip({ name: '   ' }),
        newTrip({ name: 'x'.repeat(61) }),
        newTrip({ startDate: '2026-13-45' }),
        newTrip({ endDate: 'soon' }),
        newTrip({ totalBudget: 0 }),
        newTrip({ totalBudget: 1e10 }),
        newTrip({ stops: [{ name: 'x', startDate: day(10), endDate: day(11), currency: 'eur' }] }),
        newTrip({ stops: [{ name: 'x', startDate: day(10), endDate: day(11), budget: -1 }] }),
        newTrip({ categoryBudgets: [{ categoryId: 'nope', amount: 10 }] }),
        newTrip({ categoryBudgets: [{ categoryId: FOOD, amount: 0 }] }),
      ];
      for (const body of bad) {
        const res = await http.send('POST', '/', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.ok(res.body.details, 'Zod details');
      }
      assert.equal(db.store.trips.length, before);
    });
  });

  test(`${label} POST /: dates are judged together`, async () => {
    await run(async (db, http) => {
      const before = db.store.trips.length;
      const reversed = await http.send('POST', '/', newTrip({ startDate: day(14), endDate: day(10) }));
      assert.equal(reversed.status, 400);
      assert.match(reversed.body.error, /end before it starts/);
      const outside = await http.send('POST', '/', newTrip({
        stops: [{ name: 'Madrid', startDate: day(9), endDate: day(11) }],
      }));
      assert.equal(outside.status, 400);
      assert.match(outside.body.error, /Madrid has to sit inside/);
      const backwards = await http.send('POST', '/', newTrip({
        stops: [{ name: 'Madrid', startDate: day(12), endDate: day(11) }],
      }));
      assert.equal(backwards.status, 400);
      assert.equal(db.store.trips.length, before);
    });
  });

  test(`${label} POST /: overlapping stops are allowed`, async () => {
    await run(async (_db, http) => {
      const { status } = await http.send('POST', '/', newTrip({
        stops: [
          { name: 'Madrid', startDate: day(10), endDate: day(12) },
          { name: 'Toledo', startDate: day(11), endDate: day(11) },
        ],
      }));
      assert.equal(status, 201);
    });
  });

  test(`${label} POST /: a duplicate category is a 409, and categories must be mine and for spending`, async () => {
    await run(async (db, http) => {
      const before = db.store.trips.length;
      const dup = await http.send('POST', '/', newTrip({
        categoryBudgets: [{ categoryId: FOOD, amount: 10 }, { categoryId: FOOD, amount: 20 }],
      }));
      assert.equal(dup.status, 409);
      const theirs = await http.send('POST', '/', newTrip({ categoryBudgets: [{ categoryId: THEIR_CAT, amount: 10 }] }));
      assert.equal(theirs.status, 404);
      const income = await http.send('POST', '/', newTrip({ categoryBudgets: [{ categoryId: SALARY, amount: 10 }] }));
      assert.equal(income.status, 400);
      assert.equal(db.store.trips.length, before);
    });
  });

  test(`${label} POST /: a stop currency must be quotable or the user's own`, async () => {
    await run(async (_db, http) => {
      const vnd = await http.send('POST', '/', newTrip({
        stops: [{ name: 'Hanoi', startDate: day(10), endDate: day(11), currency: 'VND' }],
      }));
      assert.equal(vnd.status, 400);
      assert.match(vnd.body.error, /VND/);
      const chf = await http.send('POST', '/', newTrip({
        stops: [{ name: 'Bern', startDate: day(10), endDate: day(11), currency: 'CHF' }],
      }));
      assert.equal(chf.status, 201);
    });
    const tables = await seed(phase);
    tables.user_stats[0].currency = 'VND';
    await run(async (_db, http) => {
      const home = await http.send('POST', '/', newTrip({
        stops: [{ name: 'Hanoi', startDate: day(10), endDate: day(11), currency: 'VND' }],
      }));
      assert.equal(home.status, 201, 'a VND-based user can set a VND stop');
    }, { tables });
  });

  test(`${label} CRITICAL: POST of a keep-out trip with the setting off turns it on and says so`, async () => {
    await run(async (db, http) => {
      const { body } = await http.send('POST', '/', newTrip({ keepOutOfMonthly: true }));
      assert.equal(body.specialEnabledNow, true);
      assert.equal(db.store.user_stats[0].special_expenses_enabled, true);
    });
  });

  test(`${label} POST: a keep-out-off trip leaves the setting off; a setting already on isn't reported`, async () => {
    await run(async (db, http) => {
      const { body } = await http.send('POST', '/', newTrip({ keepOutOfMonthly: false }));
      assert.equal(body.specialEnabledNow, false);
      assert.equal(db.store.user_stats[0].special_expenses_enabled, false);
    });
    await run(async (_db, http) => {
      const { body } = await http.send('POST', '/', newTrip({ keepOutOfMonthly: true }));
      assert.equal(body.specialEnabledNow, false);
    }, { tables: await seed(phase, { specialOn: true }) });
  });

  test(`${label} POST: the switch defaults to on when it isn't sent`, async () => {
    await run(async (_db, http) => {
      const { keepOutOfMonthly, ...rest } = newTrip();
      assert.equal(keepOutOfMonthly, false);
      const { body } = await http.send('POST', '/', rest);
      assert.equal(body.trip.keepOutOfMonthly, true);
    });
  });

  test(`${label} POST: a failed child insert leaves no half-made trip`, async () => {
    await run(async (db, http) => {
      const before = db.store.trips.length;
      const { status } = await http.send('POST', '/', newTrip({
        stops: [{ name: 'Madrid', startDate: day(10), endDate: day(11) }],
      }));
      assert.equal(status, 500);
      assert.equal(db.store.trips.length, before);
    }, { opts: { failOn: (table, op) => table === 'trip_stops' && op === 'insert' } });
  });

  // --- PATCH /:id ----------------------------------------------------------------

  const stopsAs = (startOffset) => [
    { id: ROME, name: 'Rome', startDate: day(startOffset), endDate: day(startOffset + 3), budget: 500, currency: 'EUR' },
    { id: NAPLES, name: 'Naples', startDate: day(startOffset + 4), endDate: day(startOffset + 7), budget: null, currency: null },
  ];

  test(`${label} CRITICAL: postponing a trip with its stops works in one PATCH, stop ids kept`, async () => {
    await run(async (db, http) => {
      const { status, body } = await http.send('PATCH', `/${ITALY}`, {
        startDate: day(20), endDate: day(27), stops: stopsAs(20),
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.trip.startDate, day(20));
      assert.equal(body.trip.status, 'upcoming');
      assert.deepEqual(body.trip.stops.map((s) => s.id), [ROME, NAPLES]);
      assert.equal(body.trip.stops[0].startDate, day(20));
      assert.equal(row(db, 3).trip_stop_id, NAPLES, 'overrides keep their stop');
    });
  });

  test(`${label} PATCH: moving the dates away from the stops, without sending them, is a 400`, async () => {
    await run(async (db, http) => {
      const { status, body } = await http.send('PATCH', `/${ITALY}`, { startDate: day(20), endDate: day(27) });
      assert.equal(status, 400);
      assert.match(body.error, /has to sit inside/);
      assert.equal(db.store.trips.find((t) => t.id === ITALY).start_date, day(-2));
    });
  });

  test(`${label} PATCH: a category swap is two amount updates, with no delete or insert`, async () => {
    await run(async (db, http) => {
      const { status, body } = await http.send('PATCH', `/${ITALY}`, {
        categoryBudgets: [{ categoryId: FOOD, amount: 100 }, { categoryId: FUN, amount: 200 }],
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(
        body.trip.categoryBudgets.map((b) => [b.categoryId, b.amount]),
        [[FOOD, 100], [FUN, 200]],
      );
      const writes = db.calls.filter((c) => c.table === 'trip_category_budgets' && c.op !== 'select');
      assert.deepEqual(writes.map((c) => c.op), ['update', 'update']);
    });
  });

  test(`${label} PATCH: categories missing from the list are removed, new ones inserted, same ones untouched`, async () => {
    await run(async (db, http) => {
      const { status, body } = await http.send('PATCH', `/${ITALY}`, {
        categoryBudgets: [{ categoryId: FOOD, amount: 200 }],
      });
      assert.equal(status, 200);
      assert.deepEqual(body.trip.categoryBudgets.map((b) => b.categoryId), [FOOD]);
      assert.equal(
        db.calls.filter((c) => c.table === 'trip_category_budgets' && c.op === 'update').length,
        0,
        'an unchanged amount writes nothing',
      );
    });
  });

  test(`${label} PATCH: omitting categoryBudgets leaves them alone (simple mode)`, async () => {
    await run(async (db, http) => {
      await http.send('PATCH', `/${ITALY}`, { name: 'Italia' });
      assert.equal(db.store.trip_category_budgets.filter((b) => b.trip_id === ITALY).length, 2);
    });
  });

  test(`${label} PATCH: a duplicate category 409s, a bad stop 400s, and a stop id must be this trip's`, async () => {
    await run(async (db, http) => {
      const dup = await http.send('PATCH', `/${ITALY}`, {
        categoryBudgets: [{ categoryId: FOOD, amount: 1 }, { categoryId: FOOD, amount: 2 }],
      });
      assert.equal(dup.status, 409);
      const outside = await http.send('PATCH', `/${ITALY}`, { stops: stopsAs(20) });
      assert.equal(outside.status, 400);
      const theirs = await http.send('PATCH', `/${ITALY}`, {
        stops: [{ id: THEIR_STOP, name: 'Mine now', startDate: day(-2), endDate: day(-1) }],
      });
      assert.equal(theirs.status, 404);
      assert.equal(db.store.trip_stops.find((s) => s.id === THEIR_STOP).trip_id, THEIR_TRIP);
      assert.equal((await http.send('PATCH', `/${THEIR_TRIP}`, { name: 'x' })).status, 404);
      assert.equal((await http.send('PATCH', `/${ITALY}`, {})).status, 400);
    });
  });

  test(`${label} PATCH: a removed stop's overrides are nulled and its spending stays on the trip`, async () => {
    await run(async (db, http) => {
      const { status } = await http.send('PATCH', `/${ITALY}`, {
        stops: [{ id: ROME, name: 'Rome', startDate: day(-2), endDate: day(1), budget: 500, currency: 'EUR' }],
      });
      assert.equal(status, 200);
      assert.equal(db.store.trip_stops.some((s) => s.id === NAPLES), false);
      assert.equal(row(db, 3).trip_stop_id, null);
      assert.equal(row(db, 3).trip_id, ITALY);
    });
  });

  test(`${label} CRITICAL: flipping the switch re-applies every star; an unchanged value or rename touches none`, async () => {
    await run(async (db, http) => {
      assert.equal(row(db, 3).is_special, false, 'hand-un-starred');
      await http.send('PATCH', `/${ITALY}`, { keepOutOfMonthly: true, name: 'Italia' });
      assert.equal(row(db, 3).is_special, false, 'the same value leaves it alone');
      await http.send('PATCH', `/${ITALY}`, { name: 'Italia again' });
      assert.equal(row(db, 3).is_special, false, 'a rename leaves it alone');

      await http.send('PATCH', `/${ITALY}`, { keepOutOfMonthly: false });
      for (const n of [1, 2, 3]) assert.equal(row(db, n).is_special, false);
      assert.equal(db.store.trips.find((t) => t.id === ITALY).keep_out_of_monthly, false);

      await http.send('PATCH', `/${ITALY}`, { keepOutOfMonthly: true });
      for (const n of [1, 2, 3]) assert.equal(row(db, n).is_special, true);
      assert.equal(row(db, 6).is_special, false, 'other expenses are never touched');
    });
  });

  test(`${label} CRITICAL: a flip that fails on the transactions leaves the old value, so a retry re-applies`, async () => {
    let fail = true;
    await run(async (db, http) => {
      const first = await http.send('PATCH', `/${ITALY}`, { keepOutOfMonthly: false });
      assert.equal(first.status, 500);
      assert.equal(db.store.trips.find((t) => t.id === ITALY).keep_out_of_monthly, true, 'not stored yet');
      assert.equal(row(db, 1).is_special, true);

      fail = false;
      const retry = await http.send('PATCH', `/${ITALY}`, { keepOutOfMonthly: false });
      assert.equal(retry.status, 200);
      assert.equal(row(db, 1).is_special, false);
      assert.equal(db.store.trips.find((t) => t.id === ITALY).keep_out_of_monthly, false);
    }, { opts: { failOn: (table, op) => fail && table === 'transactions' && op === 'update' } });
  });

  test(`${label} CRITICAL: a flip that fails on the trip row also re-applies on retry`, async () => {
    let fail = true;
    await run(async (db, http) => {
      assert.equal((await http.send('PATCH', `/${ITALY}`, { keepOutOfMonthly: false })).status, 500);
      assert.equal(row(db, 1).is_special, false, 'transactions go first');
      assert.equal(db.store.trips.find((t) => t.id === ITALY).keep_out_of_monthly, true);

      fail = false;
      row(db, 1).is_special = true; // a star set by hand in between is reset too
      assert.equal((await http.send('PATCH', `/${ITALY}`, { keepOutOfMonthly: false })).status, 200);
      assert.equal(row(db, 1).is_special, false);
    }, { opts: { failOn: (table, op) => fail && table === 'trips' && op === 'update' } });
  });

  test(`${label} PATCH: a rename writes every encrypted field of the trip and keeps the budget`, async () => {
    await run(async (db, http) => {
      const { body } = await http.send('PATCH', `/${ITALY}`, { name: 'Italia' });
      assert.equal(body.trip.name, 'Italia');
      assert.equal(body.trip.totalBudget, 1000);
      const write = db.calls.find((c) => c.table === 'trips' && c.op === 'update');
      if (phase === 'off') {
        assert.equal(write.payload.name, 'Italia');
        assert.equal(Number(write.payload.total_budget), 1000);
      } else {
        assert.match(String(write.payload.name_enc), /^v2:/);
        assert.match(String(write.payload.total_budget_enc), /^v2:/);
      }
    });
  });

  test(`${label} PATCH: a stop update writes both its name and its budget`, async () => {
    await run(async (db, http) => {
      const stops = stopsAs(-2);
      stops[0].name = 'Roma';
      const { status } = await http.send('PATCH', `/${ITALY}`, { stops });
      assert.equal(status, 200);
      const writes = db.calls.filter((c) => c.table === 'trip_stops' && c.op === 'update');
      assert.equal(writes.length, 1, 'the unchanged stop is not written');
      if (phase === 'off') {
        assert.equal(writes[0].payload.name, 'Roma');
        assert.equal(writes[0].payload.budget, 500);
      } else {
        assert.match(String(writes[0].payload.name_enc), /^v2:/);
        assert.match(String(writes[0].payload.budget_enc), /^v2:/);
      }
    });
  });

  test(`${label} CRITICAL: a rename-only PATCH of a keep-out trip with the setting off turns it on`, async () => {
    await run(async (db, http) => {
      const { body } = await http.send('PATCH', `/${ITALY}`, { name: 'Italia' });
      assert.equal(body.specialEnabledNow, true);
      assert.equal(db.store.user_stats[0].special_expenses_enabled, true);
    });
  });

  test(`${label} PATCH: a keep-out-off result leaves the setting off`, async () => {
    await run(async (db, http) => {
      const { body } = await http.send('PATCH', `/${PAST}`, { name: 'Skye and Mull' });
      assert.equal(body.specialEnabledNow, false);
      assert.equal(db.store.user_stats[0].special_expenses_enabled, false);
      const flipped = await http.send('PATCH', `/${ITALY}`, { keepOutOfMonthly: false });
      assert.equal(flipped.body.specialEnabledNow, false);
      assert.equal(db.store.user_stats[0].special_expenses_enabled, false);
    });
  });

  test(`${label} PATCH: archive and unarchive; a null budget clears it`, async () => {
    await run(async (db, http) => {
      const archived = await http.send('PATCH', `/${ITALY}`, { archived: true });
      assert.ok(archived.body.trip.archivedAt);
      assert.equal(row(db, 1).trip_id, ITALY, 'it keeps its expenses');
      const back = await http.send('PATCH', `/${ITALY}`, { archived: false });
      assert.equal(back.body.trip.archivedAt, null);
      const cleared = await http.send('PATCH', `/${ITALY}`, { totalBudget: null });
      assert.equal(cleared.body.trip.totalBudget, null);
      assert.equal(cleared.body.trip.remaining, null);
    });
  });

  // --- DELETE /:id ---------------------------------------------------------------

  test(`${label} DELETE ?expenses=count un-stars and untags, and spending survives`, async () => {
    await run(async (db, http) => {
      const { status } = await http.send('DELETE', `/${ITALY}?expenses=count`);
      assert.equal(status, 204);
      assert.equal(db.store.trips.some((t) => t.id === ITALY), false);
      for (const n of [1, 2, 3]) {
        assert.equal(row(db, n).trip_id, null);
        assert.equal(row(db, n).trip_stop_id, null);
        assert.equal(row(db, n).is_special, false);
      }
    });
  });

  test(`${label} DELETE ?expenses=keep untags and leaves each star as it was`, async () => {
    await run(async (db, http) => {
      assert.equal((await http.send('DELETE', `/${ITALY}?expenses=keep`)).status, 204);
      assert.equal(row(db, 1).trip_id, null);
      assert.equal(row(db, 1).is_special, true);
      assert.equal(row(db, 3).is_special, false);
    });
  });

  test(`${label} CRITICAL: DELETE ?expenses=restore leaves every row grouped, starred and trip-free, and unarchives`, async () => {
    const tables = await seed(phase);
    tables.trips[0].source_group_id = LISBON;
    tables.special_groups[0].archived_at = '2026-10-02T00:00:00Z';
    await run(async (db, http) => {
      const { status } = await http.send('DELETE', `/${ITALY}?expenses=restore`);
      assert.equal(status, 204);
      for (const n of [1, 2, 3]) {
        assert.equal(row(db, n).trip_id, null);
        assert.equal(row(db, n).trip_stop_id, null);
        assert.equal(row(db, n).special_group_id, LISBON);
        assert.equal(row(db, n).is_special, true, 'includes the one that was un-starred');
      }
      assert.equal(db.store.special_groups[0].archived_at, null);
      assert.equal(db.store.trips.some((t) => t.id === ITALY), false);
    }, { tables });
  });

  test(`${label} DELETE: restore needs a surviving group; a mode is required; ownership holds`, async () => {
    await run(async (db, http) => {
      const none = await http.send('DELETE', `/${ITALY}?expenses=restore`);
      assert.equal(none.status, 409);
      assert.equal((await http.send('DELETE', `/${ITALY}`)).status, 400);
      assert.equal((await http.send('DELETE', `/${ITALY}?expenses=burn`)).status, 400);
      assert.equal((await http.send('DELETE', `/${THEIR_TRIP}?expenses=keep`)).status, 404);
      assert.equal(db.store.trips.length, 3, 'nothing was deleted');
    });
    const tables = await seed(phase);
    tables.trips[0].source_group_id = THEIR_GROUP;
    await run(async (db, http) => {
      assert.equal((await http.send('DELETE', `/${ITALY}?expenses=restore`)).status, 409, 'never another user\'s group');
      assert.equal(row(db, 1).special_group_id, null);
    }, { tables });
  });

  test(`${label} DELETE: a failed expense update leaves the trip in place`, async () => {
    await run(async (db, http) => {
      assert.equal((await http.send('DELETE', `/${ITALY}?expenses=keep`)).status, 500);
      assert.equal(db.store.trips.some((t) => t.id === ITALY), true);
    }, { opts: { failOn: (table, op) => table === 'transactions' && op === 'update' } });
  });

  // --- GET /:id/untagged ---------------------------------------------------------

  test(`${label} untagged: during and before, with only eligible rows`, async () => {
    await run(async (_db, http) => {
      const { status, body } = await http.get(`/${ITALY}/untagged`);
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      assert.deepEqual(body.during.map((t) => t.description), ['Coffee Roma']);
      assert.deepEqual(body.before.map((t) => t.description), ['Hotel deposit']);
      assert.equal(body.during[0].amount, 3.5);
    });
  });

  test(`${label} untagged: q filters decoded text, case-insensitively, and paging happens first`, async () => {
    await run(async (_db, http) => {
      const { body } = await http.get(`/${ITALY}/untagged?q=hotel`);
      assert.deepEqual(body.during, []);
      assert.deepEqual(body.before.map((t) => t.description), ['Hotel deposit']);
    }, { opts: { maxRows: 1 } });
  });

  test(`${label} untagged: 404 for another user's trip`, async () => {
    await run(async (_db, http) => {
      assert.equal((await http.get(`/${THEIR_TRIP}/untagged`)).status, 404);
    });
  });

  // --- POST /:id/transactions ----------------------------------------------------

  test(`${label} bulk add: tags and stars for keep-out, and skips everything ineligible`, async () => {
    await run(async (db, http) => {
      const { status, body } = await http.send('POST', `/${ITALY}/transactions`, {
        transactionIds: [tid(6), tid(7), tid(9), tid(10), tid(11), tid(12), tid(13)],
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.added, 2);
      assert.equal(row(db, 6).trip_id, ITALY);
      assert.equal(row(db, 6).is_special, true);
      assert.equal(row(db, 6).trip_stop_id, null, 'no city writes: cities are derived');
      assert.equal(row(db, 9).trip_id, null, 'a subscription charge');
      assert.equal(row(db, 10).trip_id, null, 'income');
      assert.equal(row(db, 11).trip_id, null, "another user's");
      assert.equal(row(db, 12).trip_id, PAST, 'already on a trip');
      assert.equal(row(db, 13).trip_id, null, 'in a group');
    });
  });

  test(`${label} bulk add: keep-out off keeps each star as it was`, async () => {
    await run(async (db, http) => {
      await http.send('POST', `/${PAST}/transactions`, { transactionIds: [tid(6), tid(7)] });
      assert.equal(row(db, 6).trip_id, PAST);
      assert.equal(row(db, 6).is_special, false);
      assert.equal(row(db, 7).is_special, true);
    });
  });

  test(`${label} bulk add: 100 ids at most, at least one, and the trip must be mine`, async () => {
    await run(async (_db, http) => {
      const many = Array.from({ length: 101 }, (_, i) => tid(i + 100));
      assert.equal((await http.send('POST', `/${ITALY}/transactions`, { transactionIds: many })).status, 400);
      assert.equal((await http.send('POST', `/${ITALY}/transactions`, { transactionIds: [] })).status, 400);
      assert.equal((await http.send('POST', `/${ITALY}/transactions`, { transactionIds: ['nope'] })).status, 400);
      assert.equal((await http.send('POST', `/${THEIR_TRIP}/transactions`, { transactionIds: [tid(6)] })).status, 404);
      const exact = await http.send('POST', `/${ITALY}/transactions`, { transactionIds: many.slice(0, 100) });
      assert.equal(exact.status, 200);
      assert.equal(exact.body.added, 0);
    });
  });

  // --- POST /from-group ----------------------------------------------------------

  test(`${label} from-group: moves the expenses, stars them from the switch, archives the group`, async () => {
    await run(async (db, http) => {
      const { status, body } = await http.send('POST', '/from-group', {
        groupId: LISBON, trip: newTrip({ name: 'Lisbon', keepOutOfMonthly: true }),
      });
      assert.equal(status, 201, JSON.stringify(body));
      clean(body);
      assert.equal(body.moved, 3);
      assert.equal(body.groupArchived, true);
      assert.equal(body.specialEnabledNow, true, 'the setting rule holds here too');
      assert.equal(db.store.user_stats[0].special_expenses_enabled, true);
      assert.equal(body.trip.sourceGroupId, LISBON);
      assert.equal(body.trip.spent, 123.5);
      for (const n of [4, 5, 13]) {
        assert.equal(row(db, n).trip_id, body.trip.id);
        assert.equal(row(db, n).special_group_id, null);
        assert.equal(row(db, n).is_special, true);
      }
      assert.ok(db.store.special_groups[0].archived_at);
    });
  });

  test(`${label} from-group: keep-out off un-stars what it moves, so they count in their months again`, async () => {
    await run(async (db, http) => {
      const { body } = await http.send('POST', '/from-group', {
        groupId: LISBON, trip: newTrip({ keepOutOfMonthly: false }),
      });
      assert.equal(body.specialEnabledNow, false);
      assert.equal(row(db, 4).is_special, false);
      assert.equal(row(db, 4).trip_id, body.trip.id);
    });
  });

  test(`${label} from-group: a subscription-linked charge stays behind in the group`, async () => {
    const tables = await seed(phase);
    tables.transactions.find((t) => t.id === tid(5)).recurrence_id = REC;
    await run(async (db, http) => {
      const { body } = await http.send('POST', '/from-group', { groupId: LISBON, trip: newTrip() });
      assert.equal(body.moved, 2);
      assert.equal(row(db, 5).trip_id, null);
      assert.equal(row(db, 5).special_group_id, LISBON);
    }, { tables });
  });

  test(`${label} from-group: a failed move deletes the trip and leaves the group intact`, async () => {
    await run(async (db, http) => {
      const before = db.store.trips.length;
      const { status } = await http.send('POST', '/from-group', { groupId: LISBON, trip: newTrip() });
      assert.equal(status, 500);
      assert.equal(db.store.trips.length, before);
      assert.equal(row(db, 4).special_group_id, LISBON);
      assert.equal(db.store.special_groups[0].archived_at, null);
    }, { opts: { failOn: (table, op) => table === 'transactions' && op === 'update' } });
  });

  test(`${label} from-group: if only the archive fails the trip stands and the group stays active`, async () => {
    await run(async (db, http) => {
      const { status, body } = await http.send('POST', '/from-group', { groupId: LISBON, trip: newTrip() });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.groupArchived, false);
      assert.equal(row(db, 4).trip_id, body.trip.id);
      assert.equal(db.store.special_groups[0].archived_at, null);
    }, { opts: { failOn: (table, op) => table === 'special_groups' && op === 'update' } });
  });

  test(`${label} from-group: another user's group is a 404; the body is validated like POST`, async () => {
    await run(async (db, http) => {
      const before = db.store.trips.length;
      const theirs = await http.send('POST', '/from-group', { groupId: THEIR_GROUP, trip: newTrip() });
      assert.equal(theirs.status, 404);
      const invalid = await http.send('POST', '/from-group', { groupId: LISBON, trip: newTrip({ name: '' }) });
      assert.equal(invalid.status, 400);
      const reversed = await http.send('POST', '/from-group', {
        groupId: LISBON, trip: newTrip({ startDate: day(14), endDate: day(10) }),
      });
      assert.equal(reversed.status, 400);
      assert.equal(db.store.trips.length, before);
      assert.equal(row(db, 4).special_group_id, LISBON);
    });
  });

  // --- GET /api/special-groups ---------------------------------------------------

  test(`${label} special groups give every expense date, past the row cap, for Start from a group`, async () => {
    const { fakeSupabase, serve } = await import('./routeHarness.js');
    currentDb = fakeSupabase(await seed(phase), { maxRows: 1 });
    if (!mocked) {
      mock.module('../../lib/supabase.js', { exports: { supabase: supabaseProxy } });
      mocked = true;
    }
    const { default: router } = await import('../../routes/specialGroups.js');
    const http = await serve(router, { userId: U, mountAt: '/api/special-groups' });
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      const lisbon = body.groups.find((g) => g.id === LISBON);
      assert.equal(lisbon.count, 3);
      assert.equal(lisbon.total, 123.5);
      assert.deepEqual(lisbon.dates, ['2026-07-01', '2026-08-20', day(-1)].sort());
      assert.equal(lisbon.firstDate, lisbon.dates[0]);
    } finally {
      await http.close();
    }
  });
}
