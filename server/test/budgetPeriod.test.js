import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyEquivalentLimit } from '../lib/budgetPeriod.js';

test('a monthly budget is left exactly alone', () => {
  assert.equal(monthlyEquivalentLimit(260, 'monthly', '2026-08'), 260);
  assert.equal(monthlyEquivalentLimit(0, 'monthly', '2026-08'), 0);
  // Anything that is not explicitly weekly is treated as monthly.
  assert.equal(monthlyEquivalentLimit(100, undefined, '2026-08'), 100);
});

test('a weekly budget scales to the month it is measured against', () => {
  // The bug: £50/week vs a whole month of spend read as ~430% used.
  assert.equal(monthlyEquivalentLimit(50, 'weekly', '2026-08'), 221.43); // 31 days
  assert.equal(monthlyEquivalentLimit(50, 'weekly', '2026-04'), 214.29); // 30 days
  assert.equal(monthlyEquivalentLimit(50, 'weekly', '2026-02'), 200); // 28 days, exactly 4 weeks
  assert.equal(monthlyEquivalentLimit(50, 'weekly', '2028-02'), 207.14); // 29, leap
});

test('the scaling actually fixes the percentage it was breaking', () => {
  const weeklyLimit = 50;
  const monthSpend = 215; // a bit under four and a half weeks of allowance
  const naive = monthSpend / weeklyLimit;
  const fixed = monthSpend / monthlyEquivalentLimit(weeklyLimit, 'weekly', '2026-08');
  assert.ok(naive > 4, `naive comparison claimed ${Math.round(naive * 100)}% used`);
  assert.ok(fixed > 0.9 && fixed < 1, `scaled comparison gives ${Math.round(fixed * 100)}%`);
});

test('a zero weekly limit stays zero rather than becoming NaN', () => {
  assert.equal(monthlyEquivalentLimit(0, 'weekly', '2026-08'), 0);
});
