import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayInZone,
  ymInZone,
  addMonths,
  daysInMonth,
  dayOfMonth,
  monthBounds,
  DEFAULT_TIMEZONE,
} from '../lib/month.js';

// The exact instant that motivated this file: 00:30 on 1 September in Paris,
// which is 22:30 on 31 August in UTC. Alex's actual failure mode while abroad.
const PARIS_MIDNIGHT = new Date('2026-08-31T22:30:00Z');

test('the same instant is a different day, and month, in different zones', () => {
  assert.equal(dayInZone('UTC', PARIS_MIDNIGHT), '2026-08-31');
  assert.equal(dayInZone('Europe/Paris', PARIS_MIDNIGHT), '2026-09-01');
  assert.equal(dayInZone('Europe/London', PARIS_MIDNIGHT), '2026-08-31');
  assert.equal(dayInZone('Asia/Ho_Chi_Minh', PARIS_MIDNIGHT), '2026-09-01');
});

test('month bounds follow the user, not the server — the whole point', () => {
  const utc = monthBounds('UTC', PARIS_MIDNIGHT);
  const paris = monthBounds('Europe/Paris', PARIS_MIDNIGHT);

  assert.deepEqual(utc, { ym: '2026-08', firstISO: '2026-08-01', nextFirstISO: '2026-09-01' });
  assert.deepEqual(paris, { ym: '2026-09', firstISO: '2026-09-01', nextFirstISO: '2026-10-01' });

  // A transaction the Paris user just logged, dated in THEIR day.
  const justLogged = '2026-09-01';
  const inUtcWindow = justLogged >= utc.firstISO && justLogged < utc.nextFirstISO;
  const inParisWindow = justLogged >= paris.firstISO && justLogged < paris.nextFirstISO;
  assert.equal(inUtcWindow, false, 'this is the bug: invisible under the server clock');
  assert.equal(inParisWindow, true, 'and this is the fix');
});

test('London BST has the same one-hour window', () => {
  // 00:30 BST on 1 Aug === 23:30 UTC on 31 Jul.
  const d = new Date('2026-07-31T23:30:00Z');
  assert.equal(ymInZone('UTC', d), '2026-07');
  assert.equal(ymInZone('Europe/London', d), '2026-08');
});

test('London in winter is UTC, so no window at all', () => {
  const d = new Date('2026-01-31T23:30:00Z'); // GMT, no offset
  assert.equal(ymInZone('UTC', d), '2026-01');
  assert.equal(ymInZone('Europe/London', d), '2026-01');
});

test('zones west of UTC move the other way', () => {
  // 20:00 on 31 Aug in New York === 00:00 on 1 Sep UTC.
  const d = new Date('2026-09-01T00:00:00Z');
  assert.equal(ymInZone('UTC', d), '2026-09');
  assert.equal(ymInZone('America/New_York', d), '2026-08');
});

test('addMonths crosses years in both directions', () => {
  assert.equal(addMonths('2026-08', 1), '2026-09');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-01', -13), '2024-12');
  assert.equal(addMonths('2026-06', 0), '2026-06');
  assert.equal(addMonths('2026-06', 24), '2028-06');
});

test('daysInMonth handles short months and leap years', () => {
  assert.equal(daysInMonth('2026-01'), 31);
  assert.equal(daysInMonth('2026-04'), 30);
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29); // leap
  assert.equal(daysInMonth('2100-02'), 28); // century, not a leap year
});

test('dayOfMonth reads the day back out', () => {
  assert.equal(dayOfMonth('2026-09-01'), 1);
  assert.equal(dayOfMonth('2026-09-30'), 30);
});

test('a missing or nonsense zone falls back to UTC instead of throwing', () => {
  assert.equal(dayInZone(null, PARIS_MIDNIGHT), '2026-08-31');
  assert.equal(dayInZone(undefined, PARIS_MIDNIGHT), '2026-08-31');
  assert.equal(dayInZone('', PARIS_MIDNIGHT), '2026-08-31');
  assert.equal(dayInZone('Not/AZone', PARIS_MIDNIGHT), '2026-08-31');
  assert.equal(DEFAULT_TIMEZONE, 'UTC');
});

test('a DST transition does not shift the calendar day', () => {
  // Europe/London springs forward 01:00 -> 02:00 on 2026-03-29.
  const beforeJump = new Date('2026-03-29T00:30:00Z');
  const afterJump = new Date('2026-03-29T02:30:00Z');
  assert.equal(dayInZone('Europe/London', beforeJump), '2026-03-29');
  assert.equal(dayInZone('Europe/London', afterJump), '2026-03-29');
});
