import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tripStatus, stopForDate, tripForDate, cityOf, summariseTrip } from '../lib/trips.js';

const italy = { id: 't1', start_date: '2026-10-12', end_date: '2026-10-19', total_budget: 1000 };
const rome = { id: 's1', start_date: '2026-10-12', end_date: '2026-10-15', budget: 400, created_at: '2026-10-01T10:00:00Z' };
const milan = { id: 's2', start_date: '2026-10-16', end_date: '2026-10-19', budget: null, created_at: '2026-10-01T10:00:00Z' };

test('tripStatus: the day before the start is upcoming, counted to the start', () => {
  assert.deepEqual(tripStatus(italy, '2026-10-08'), {
    status: 'upcoming',
    daysUntilStart: 4,
    dayOfTrip: null,
    length: 8,
    daysLeft: null,
  });
  assert.equal(tripStatus(italy, '2026-10-11').daysUntilStart, 1);
});

test('tripStatus: the start day and the end day are both active, and inclusive', () => {
  assert.deepEqual(tripStatus(italy, '2026-10-12'), {
    status: 'active',
    daysUntilStart: null,
    dayOfTrip: 1,
    length: 8,
    daysLeft: 8,
  });
  const last = tripStatus(italy, '2026-10-19');
  assert.equal(last.status, 'active');
  assert.equal(last.dayOfTrip, 8);
  assert.equal(last.daysLeft, 1, 'today still counts');
});

test('tripStatus: the day after the end is past', () => {
  assert.deepEqual(tripStatus(italy, '2026-10-20'), {
    status: 'past',
    daysUntilStart: null,
    dayOfTrip: null,
    length: 8,
    daysLeft: null,
  });
});

test('tripStatus: a single-day trip is one day long and active on that day', () => {
  const day = { start_date: '2026-10-12', end_date: '2026-10-12' };
  const s = tripStatus(day, '2026-10-12');
  assert.equal(s.status, 'active');
  assert.equal(s.length, 1);
  assert.equal(s.dayOfTrip, 1);
  assert.equal(s.daysLeft, 1);
});

test('tripStatus: counts days across a clock change without drifting', () => {
  // UK clocks go back on 25 Oct 2026; local-midnight arithmetic would give 8.99 days.
  const s = tripStatus({ start_date: '2026-10-20', end_date: '2026-10-30' }, '2026-10-22');
  assert.equal(s.length, 11);
  assert.equal(s.daysLeft, 9);
});

test('total order: a day trip inside a stop wins on its day, and only on its day', () => {
  const pompeii = { id: 's3', start_date: '2026-10-14', end_date: '2026-10-14', created_at: '2026-10-02T10:00:00Z' };
  const stops = [rome, pompeii];
  assert.equal(stopForDate(stops, '2026-10-14').id, 's3');
  assert.equal(stopForDate(stops, '2026-10-13').id, 's1');
  assert.equal(stopForDate(stops, '2026-10-15').id, 's1');
});

test('total order: on equal starts the shorter span wins', () => {
  const short = { id: 'z', start_date: '2026-10-12', end_date: '2026-10-13' };
  const long = { id: 'a', start_date: '2026-10-12', end_date: '2026-10-20' };
  assert.equal(stopForDate([long, short], '2026-10-12').id, 'z');
});

test('total order: same dates fall to the earliest created, then to the id', () => {
  const later = { id: 'a', start_date: '2026-10-12', end_date: '2026-10-13', created_at: '2026-10-02T00:00:00Z' };
  const earlier = { id: 'b', start_date: '2026-10-12', end_date: '2026-10-13', created_at: '2026-10-01T00:00:00Z' };
  assert.equal(stopForDate([later, earlier], '2026-10-12').id, 'b');

  const twinA = { id: 'a', start_date: '2026-10-12', end_date: '2026-10-13', created_at: '2026-10-01T00:00:00Z' };
  const twinB = { id: 'b', start_date: '2026-10-12', end_date: '2026-10-13', created_at: '2026-10-01T00:00:00Z' };
  assert.equal(stopForDate([twinB, twinA], '2026-10-12').id, 'a');
});

test('tripForDate: archived trips never match, and no trip means null', () => {
  const archived = { id: 't9', start_date: '2026-10-12', end_date: '2026-10-19', archived_at: '2026-10-20T00:00:00Z' };
  assert.equal(tripForDate([archived], '2026-10-14'), null);
  assert.equal(tripForDate([archived, italy], '2026-10-14').id, 't1');
  assert.equal(tripForDate([italy], '2026-11-01'), null);
});

test('stopForDate does not mutate the list it is given', () => {
  const stops = [milan, rome];
  stopForDate(stops, '2026-10-16');
  assert.deepEqual(stops.map((s) => s.id), ['s2', 's1']);
});

test('cityOf: an override beats the date', () => {
  assert.equal(cityOf({ date: '2026-10-13', trip_stop_id: 's2' }, [rome, milan]).id, 's2');
});

test('cityOf: with no override the date decides; a pre-trip date is No city', () => {
  assert.equal(cityOf({ date: '2026-10-13', trip_stop_id: null }, [rome, milan]).id, 's1');
  assert.equal(cityOf({ date: '2026-03-02', trip_stop_id: null }, [rome, milan]), null);
});

test('cityOf: an override naming a stop no longer listed falls back to the date', () => {
  assert.equal(cityOf({ date: '2026-10-13', trip_stop_id: 'gone' }, [rome, milan]).id, 's1');
});

const food = 'cat-food';
const hotels = 'cat-hotels';
const fun = 'cat-fun';
const budgets = [
  { category_id: food, amount_limit: 200 },
  { category_id: hotels, amount_limit: '300' },
];
const txs = [
  { amount: '19.99', date: '2026-10-13', category_id: food, trip_stop_id: null },
  { amount: 0.01, date: '2026-10-17', category_id: food, trip_stop_id: null },
  { amount: 150, date: '2026-10-14', category_id: fun, trip_stop_id: 's2' },
  { amount: 89.1, date: '2026-03-02', category_id: 'cat-flights', trip_stop_id: null },
];

test('summariseTrip: city totals and category totals add up to spent exactly', () => {
  // 0.1 + 0.2 style float error would make these unequal if amounts were summed as floats.
  const many = Array.from({ length: 30 }, (_, i) => ({
    amount: 0.1,
    date: i % 2 ? '2026-10-13' : '2026-10-17',
    category_id: i % 3 ? food : null,
    trip_stop_id: null,
  }));
  const s = summariseTrip(italy, [rome, milan], budgets, many, '2026-10-14');
  assert.equal(s.spent, 3);
  const cityTotal = s.byStop.reduce((sum, b) => sum + Math.round(b.spent * 100), 0) + Math.round(s.noCitySpent * 100);
  assert.equal(cityTotal, 300);
  const categoryTotal = s.byCategory.reduce((sum, b) => sum + Math.round(b.spent * 100), 0);
  assert.equal(categoryTotal, 300);
  assert.equal(s.count, 30);
});

test('summariseTrip: decoded string amounts are summed as numbers, and buckets are right', () => {
  const s = summariseTrip(italy, [rome, milan], budgets, txs, '2026-10-14');
  assert.equal(s.spent, 259.1);
  assert.deepEqual(s.byStop, [
    { stopId: 's1', budget: 400, spent: 19.99 },
    { stopId: 's2', budget: null, spent: 150.01 },
  ]);
  assert.equal(s.noCitySpent, 89.1, 'the pre-trip flight lands under No city');
  assert.equal(s.count, 4);
});

test('summariseTrip: budget lines come first even with no spend; the rest is Other categories', () => {
  const s = summariseTrip(italy, [rome, milan], budgets, txs, '2026-10-14');
  assert.deepEqual(s.byCategory, [
    { categoryId: food, limit: 200, spent: 20 },
    { categoryId: hotels, limit: 300, spent: 0 },
    { categoryId: fun, limit: null, spent: 150 },
    { categoryId: 'cat-flights', limit: null, spent: 89.1 },
  ]);
  assert.equal(s.otherCategoriesSpent, 239.1);
});

test('summariseTrip: per-day is what is left over the days left, including today', () => {
  const s = summariseTrip(italy, [], [], [{ amount: 360, date: '2026-10-13' }], '2026-10-15');
  assert.equal(s.remaining, 640);
  assert.equal(s.perDayLeft, 128, '£640 over the 5 days 15th to 19th');
  assert.equal(s.overBy, 0);
});

test('summariseTrip: over budget floors what is left at 0 and overBy carries the excess', () => {
  const s = summariseTrip(italy, [], [], [{ amount: 1055, date: '2026-10-13' }], '2026-10-18');
  assert.equal(s.remaining, 0);
  assert.equal(s.perDayLeft, 0);
  assert.equal(s.overBy, 55);
});

test('summariseTrip: per-day exists only while active', () => {
  const tx = [{ amount: 100, date: '2026-10-13' }];
  const upcoming = summariseTrip(italy, [], [], tx, '2026-10-01');
  assert.equal(upcoming.perDayLeft, null);
  assert.equal(upcoming.remaining, 900);
  const past = summariseTrip(italy, [], [], tx, '2026-10-20');
  assert.equal(past.perDayLeft, null);
  assert.equal(past.remaining, 900, 'came in under by this much');
});

test('summariseTrip: no overall budget still gives spent and the bars', () => {
  const s = summariseTrip({ ...italy, total_budget: null }, [rome, milan], budgets, txs, '2026-10-14');
  assert.equal(s.totalBudget, null);
  assert.equal(s.remaining, null);
  assert.equal(s.perDayLeft, null);
  assert.equal(s.overBy, 0);
  assert.equal(s.spent, 259.1);
  assert.equal(s.byCategory[0].spent, 20);
  assert.equal(s.byStop[0].spent, 19.99);
});

test('summariseTrip: a trip with no expenses is all zeroes, never NaN', () => {
  const s = summariseTrip(italy, [rome], budgets, [], '2026-10-14');
  assert.equal(s.spent, 0);
  assert.equal(s.remaining, 1000);
  assert.equal(s.noCitySpent, 0);
  assert.equal(s.otherCategoriesSpent, 0);
  assert.equal(s.count, 0);
  assert.deepEqual(s.byStop, [{ stopId: 's1', budget: 400, spent: 0 }]);
});
