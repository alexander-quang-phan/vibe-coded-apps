import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextRunDate,
  advanceToFuture,
  dueRecurrences,
  manualMerchantKey,
  utcDayOfMonth,
} from '../lib/recurrences.js';

// --- nextRunDate -------------------------------------------------------------

test('weekly rollover across a month boundary', () => {
  assert.equal(nextRunDate('2026-01-28', 'weekly'), '2026-02-04');
});

test('weekly rollover across a year boundary', () => {
  assert.equal(nextRunDate('2026-12-28', 'weekly'), '2027-01-04');
});

test('monthly: 31 Jan clamps to 28 Feb in a non-leap year', () => {
  assert.equal(nextRunDate('2026-01-31', 'monthly'), '2026-02-28');
});

test('monthly: 31 Jan clamps to 29 Feb in a leap year', () => {
  assert.equal(nextRunDate('2024-01-31', 'monthly'), '2024-02-29');
});

test('monthly anchor-drift trap: naive chaining off the clamped date drifts to the 28th', () => {
  // This is the bug the anchorDay param exists to prevent — asserted here so
  // a future refactor that "simplifies" nextRunDate away from anchorDay trips
  // this test instead of shipping silently.
  const clamped = nextRunDate('2026-01-31', 'monthly'); // '2026-02-28'
  const naive = nextRunDate(clamped, 'monthly'); // no anchor -> reuses day 28
  assert.equal(naive, '2026-03-28');
});

test('monthly anchor-drift trap: passing the original anchor day recovers to the 31st', () => {
  const clamped = nextRunDate('2026-01-31', 'monthly'); // '2026-02-28'
  const recovered = nextRunDate(clamped, 'monthly', 31);
  assert.equal(recovered, '2026-03-31');
});

test('monthly: mid-month day needs no clamping', () => {
  assert.equal(nextRunDate('2026-03-15', 'monthly'), '2026-04-15');
});

test('monthly: year rollover Dec -> Jan', () => {
  assert.equal(nextRunDate('2026-12-20', 'monthly'), '2027-01-20');
});

test('unknown interval throws', () => {
  assert.throws(() => nextRunDate('2026-01-01', 'daily'));
});

// --- advanceToFuture ---------------------------------------------------------

test('advanceToFuture makes only the normal single jump when not overdue by multiple periods', () => {
  const next = advanceToFuture('2026-07-01', 'monthly', 1, '2026-07-18');
  assert.equal(next, '2026-08-01');
});

test('advanceToFuture fast-forwards past several missed periods in one jump (no backfill)', () => {
  // Schedule stuck on 2026-01-05 monthly (app asleep for months) — today is
  // 2026-05-10. It must land on the next FUTURE date, not step through every
  // missed month one at a time (that would imply N missed transactions).
  const next = advanceToFuture('2026-01-05', 'monthly', 5, '2026-05-10');
  assert.equal(next, '2026-06-05');
  assert.ok(next > '2026-05-10');
});

// --- dueRecurrences -----------------------------------------------------------

test('dueRecurrences includes rows due today or earlier and excludes cancelled/future rows', () => {
  const rows = [
    { id: 'a', next_run_at: '2026-07-17', cancelled_at: null },
    { id: 'b', next_run_at: '2026-07-18', cancelled_at: null },
    { id: 'c', next_run_at: '2026-07-19', cancelled_at: null }, // future
    { id: 'd', next_run_at: '2026-07-10', cancelled_at: '2026-07-11T00:00:00Z' }, // cancelled
  ];
  const due = dueRecurrences(rows, '2026-07-18');
  assert.deepEqual(due.map((r) => r.id), ['a', 'b']);
});

// --- manualMerchantKey / utcDayOfMonth ----------------------------------------

test('manualMerchantKey formats the /subscriptions row key', () => {
  assert.equal(manualMerchantKey('abc-123'), 'manual:abc-123');
});

test('utcDayOfMonth reads the day from a timestamptz string', () => {
  assert.equal(utcDayOfMonth('2026-07-18T09:30:00.000Z'), 18);
});
