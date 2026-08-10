import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunningAverage } from '../lib/runningAverage.js';

// A month shaped exactly as routes/analytics.js builds it. `special` is already
// zeroed server-side when the user's preference is off, so tests set it directly.
const m = (ym, expenses, { income = 2000, special = 0 } = {}) => ({
  ym,
  label: ym,
  income,
  expenses,
  net: income - expenses,
  special,
});

const empty = (ym) => ({ ym, label: ym, income: 0, expenses: 0, net: 0, special: 0 });

// Jan–Dec 2026 at 100, 200, … 1200. Used by the windowing tests.
const twelveMonths = () =>
  Array.from({ length: 12 }, (_, i) => m(`2026-${String(i + 1).padStart(2, '0')}`, (i + 1) * 100));

test('averages the last six completed months, excluding the month in progress', () => {
  const series = [
    m('2026-02', 1300),
    m('2026-03', 1100),
    m('2026-04', 1250),
    m('2026-05', 1180),
    m('2026-06', 1320),
    m('2026-07', 1290),
    m('2026-08', 410), // in progress — must not count
  ];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 6);
  assert.equal(r.from, '2026-02');
  assert.equal(r.to, '2026-07');
  assert.equal(r.inclSpecial, 1240); // 7440 / 6
});

test('shorter history than the window: averages what exists and reports the count', () => {
  const series = [m('2026-05', 1000), m('2026-06', 1100), m('2026-07', 1200), m('2026-08', 300)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 3);
  assert.equal(r.inclSpecial, 1100);
});

test('no completed months at all returns null', () => {
  const r = buildRunningAverage({ series: [m('2026-08', 410)], months: 6, currentYm: '2026-08' });
  assert.equal(r, null);
});

test('leading pre-signup months are trimmed and do not dilute the mean', () => {
  const series = [
    empty('2026-01'),
    empty('2026-02'),
    m('2026-03', 1000),
    m('2026-04', 1200),
    m('2026-05', 800),
  ];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 3);
  assert.equal(r.from, '2026-03');
  assert.equal(r.inclSpecial, 1000); // 3000 / 3, NOT 3000 / 5
  assert.deepEqual(r.emptyYms, []);
});

test('a zero month INSIDE the history counts as £0 and is reported', () => {
  const series = [m('2026-04', 1200), empty('2026-05'), m('2026-06', 1200)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 3);
  assert.equal(r.inclSpecial, 800); // 2400 / 3 — the gap pulls it down
  assert.deepEqual(r.emptyYms, ['2026-05']);
});

test('multiple gaps are all reported, in ascending order', () => {
  const series = [
    m('2026-03', 900),
    empty('2026-04'),
    m('2026-05', 900),
    empty('2026-06'),
    m('2026-07', 900),
  ];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.deepEqual(r.emptyYms, ['2026-04', '2026-06']);
  assert.equal(r.inclSpecial, 540); // 2700 / 5
});

test('a trimmed LEADING zero month is not reported as a gap', () => {
  const series = [empty('2026-02'), m('2026-03', 1000), empty('2026-04'), m('2026-05', 1000)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.deepEqual(r.emptyYms, ['2026-04']);
  assert.equal(r.monthsUsed, 3);
  assert.equal(r.inclSpecial, 666.67); // 2000 / 3, rounded
});

test('special spend lowers exclSpecial by exactly its mean', () => {
  const series = [
    m('2026-05', 1000, { special: 300 }),
    m('2026-06', 1000, { special: 0 }),
    m('2026-07', 1000, { special: 600 }),
  ];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.inclSpecial, 1000);
  assert.equal(r.exclSpecial, 700); // (700 + 1000 + 400) / 3
});

test('preference off (no special anywhere) leaves the two figures equal', () => {
  const series = [m('2026-06', 1000), m('2026-07', 1400)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.inclSpecial, 1200);
  assert.equal(r.exclSpecial, 1200);
});

test('more completed months than the window: only the last N are used', () => {
  const r = buildRunningAverage({ series: twelveMonths(), months: 6, currentYm: '2027-01' });
  assert.equal(r.from, '2026-07');
  assert.equal(r.to, '2026-12');
  assert.equal(r.inclSpecial, 950); // (700+800+900+1000+1100+1200) / 6
});

test('exactly one completed month', () => {
  const series = [m('2026-07', 1234.56), m('2026-08', 100)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 1);
  assert.equal(r.from, '2026-07');
  assert.equal(r.to, '2026-07');
  assert.equal(r.inclSpecial, 1234.56);
});

test('the 3 / 6 / 12 windows differ, and a window longer than the history clamps', () => {
  const series = twelveMonths();
  const at = (months) => buildRunningAverage({ series, months, currentYm: '2027-01' });
  assert.equal(at(3).inclSpecial, 1100); // (1000+1100+1200) / 3
  assert.equal(at(6).inclSpecial, 950);
  assert.equal(at(12).inclSpecial, 650); // 7800 / 12
  assert.equal(at(24).monthsUsed, 12);
  assert.equal(at(24).inclSpecial, 650);
});
