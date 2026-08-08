import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTotalBudget, buildPace } from '../lib/overallBudget.js';

// Alex's actual shape: Food and Rent budgeted, Entertainment and Groceries not.
const spend = () =>
  new Map([
    ['food', 200],
    ['rent', 900],
    ['entertainment', 150],
    ['groceries', 100],
  ]); // 1350 total, 1100 of it in budgeted categories

const catBudgets = [
  { category_id: 'food', amount_limit: 300 },
  { category_id: 'rent', amount_limit: 900 },
]; // 1200 of category limits

test('overall budget set + category budgets: overall wins, ALL spend counts', () => {
  const r = resolveTotalBudget({
    monthlyLimit: 1200,
    monthlyBudgets: catBudgets,
    spendByCat: spend(),
  });
  assert.equal(r.source, 'overall');
  // NOT 1200 + 300 + 900 = 2400 — that double-count is the bug this fixes.
  assert.equal(r.limit, 1200);
  assert.equal(r.spent, 1350);
});

test('overall budget set, no category budgets', () => {
  const r = resolveTotalBudget({ monthlyLimit: 1200, monthlyBudgets: [], spendByCat: spend() });
  assert.equal(r.source, 'overall');
  assert.equal(r.limit, 1200);
  assert.equal(r.spent, 1350);
});

test('no overall budget: sum of category limits vs BUDGETED spend only', () => {
  const r = resolveTotalBudget({
    monthlyLimit: null,
    monthlyBudgets: catBudgets,
    spendByCat: spend(),
  });
  assert.equal(r.source, 'categories');
  assert.equal(r.limit, 1200);
  // 200 + 900 — the unbudgeted 250 must NOT count against a limit that never
  // covered it. This is the defect that made partial budgeting read as
  // permanently ahead of pace.
  assert.equal(r.spent, 1100);
});

test('no budgets at all: no total to show', () => {
  const r = resolveTotalBudget({ monthlyLimit: null, monthlyBudgets: [], spendByCat: spend() });
  assert.equal(r.source, 'none');
  assert.equal(r.limit, null);
});

test('a zero or negative overall limit falls through to category budgets', () => {
  const r = resolveTotalBudget({ monthlyLimit: 0, monthlyBudgets: catBudgets, spendByCat: spend() });
  assert.equal(r.source, 'categories');
  assert.equal(r.limit, 1200);
});

test('pace: under budget gives a positive per-day allowance', () => {
  // Day 8 of 31, £1200 budget, £240 spent.
  const p = buildPace({ limit: 1200, spent: 240, daysElapsed: 8, daysInMonth: 31 });
  assert.equal(p.budget, 1200);
  assert.equal(p.target, 309.68); // 1200 * 8 / 31
  assert.equal(p.spent, 240);
  assert.equal(p.delta, 69.68); // under pace
  assert.equal(p.daysRemaining, 24); // 31 - 8 + 1, today included
  assert.equal(p.perDayLeft, 40); // (1200 - 240) / 24
  assert.equal(p.overBy, 0);
});

test('pace: over pace but still under budget still has an allowance', () => {
  const p = buildPace({ limit: 1200, spent: 600, daysElapsed: 8, daysInMonth: 31 });
  assert.ok(p.delta < 0, 'negative delta means ahead of the run-rate');
  assert.equal(p.perDayLeft, 25); // (1200 - 600) / 24
  assert.equal(p.overBy, 0);
});

test('pace: over budget reports the overage and zero per day, never a negative', () => {
  const p = buildPace({ limit: 1200, spent: 1380, daysElapsed: 20, daysInMonth: 31 });
  assert.equal(p.overBy, 180);
  assert.equal(p.perDayLeft, 0, 'a negative per-day figure is meaningless');
  assert.equal(p.daysRemaining, 12);
});

test('pace: last day of the month still leaves one day, never divides by zero', () => {
  const p = buildPace({ limit: 1200, spent: 600, daysElapsed: 31, daysInMonth: 31 });
  assert.equal(p.daysRemaining, 1);
  assert.equal(p.perDayLeft, 600);
  assert.ok(Number.isFinite(p.perDayLeft));
});

test('pace: no limit means no pace line at all', () => {
  assert.equal(buildPace({ limit: null, spent: 100, daysElapsed: 8, daysInMonth: 31 }), null);
  assert.equal(buildPace({ limit: 0, spent: 100, daysElapsed: 8, daysInMonth: 31 }), null);
});
