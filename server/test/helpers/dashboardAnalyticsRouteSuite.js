/**
 * The dashboard and analytics routes, over real HTTP against a fake database.
 *
 * Both are read-only and fully aggregated, so the risk is not a leak — it is a
 * WRONG NUMBER. A missed decode does not throw; it produces `undefined`, and
 * `Number(undefined)` is NaN, which serialises as `null` in JSON. The user sees a
 * blank or zeroed figure and nothing anywhere reports an error.
 *
 * dashboard.js had exactly that waiting in two places before the sweep:
 * `stats.monthly_limit` read through `select('*')`, and a budget loop still
 * reading the raw query result.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const CAT = '11111111-1111-4111-8111-111111111111';

const thisMonth = () => new Date().toISOString().slice(0, 7);

async function seed(phase) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  const m = thisMonth();
  const tx = (id, amount, type, description, day, extra = {}) => ({
    id, user_id: U, category_id: CAT, type, date: `${m}-${day}`, is_special: false,
    original_currency: null, fx_rate: null, created_at: `${m}-${day}T10:00:00Z`, ...extra,
    ...encodeWrite('transactions', U, { amount, description, original_amount: null }, phase),
  });
  return {
    transactions: [
      tx('t1', 100, 'expense', 'Tesco Express', '05'),
      tx('t2', 40, 'expense', 'Boots 55', '06'),
      tx('t3', 2000, 'income', 'Salary', '01'),
    ],
    categories: [{
      id: CAT, user_id: U, icon: '🛒', color: '#84cc16', type: 'expense',
      ...encodeWrite('categories', U, { name: 'Groceries' }, phase),
    }],
    budgets: [{
      id: 'b1', user_id: U, category_id: CAT, period: 'monthly',
      // 100, deliberately: dashboard only raises an alert at >=75% used, and the
      // fixture spends 140 (or 100 with the special row excluded), so an alert
      // appears in both variants and its `spent` is what the assertions read.
      ...encodeWrite('budgets', U, { amount_limit: 100 }, phase),
    }],
    user_stats: [{
      user_id: U, currency: 'GBP', timezone: 'UTC', special_expenses_enabled: false,
      simple_mode: false, display_name: 'Alex', current_streak: 3, longest_streak: 5,
      shields: 1, xp_points: 100, level: 2, last_logged_date: `${m}-06`, badges: [],
      ...encodeWrite('user_stats', U, { monthly_limit: 1500 }, phase),
    }],
  };
}

export function runDashboardAnalyticsRouteSuite(phase) {
  const label = `[phase=${phase}]`;

  let currentDb = null;
  let mocked = false;
  const supabaseProxy = {
    from: (t) => currentDb.from(t),
    rpc: (...args) => currentDb.rpc(...args),
  };

  async function boot(which, tables) {
    const { fakeSupabase, serve } = await import('./routeHarness.js');
    currentDb = fakeSupabase(tables ?? (await seed(phase)));
    if (!mocked) {
      mock.module('../../lib/supabase.js', { exports: { supabase: supabaseProxy } });
      mocked = true;
    }
    const { default: router } = await import(`../../routes/${which}.js`);
    const http = await serve(router, { userId: U, mountAt: `/api/${which}` });
    return { db: currentDb, http };
  }

  /** No total anywhere may be NaN or a null that should have been a number. */
  function assertNoSilentNaN(body) {
    const json = JSON.stringify(body);
    assert.ok(!json.includes('NaN'), 'no field may serialise as NaN');
    assert.ok(!json.includes('_enc'), 'no ciphertext column may appear');
    assert.ok(!json.includes('v2:'), 'no envelope may appear');
  }

  // --- dashboard --------------------------------------------------------------

  test(`${label} dashboard totals are identical in every phase`, async () => {
    const { http } = await boot('dashboard');
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.month.income, 2000);
      assert.equal(body.month.expenses, 140, '100 + 40');
      assert.equal(body.month.balance, 1860);
      assert.equal(body.month.transactionCount, 3);
      assertNoSilentNaN(body);
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: monthly_limit survives being read through select('*')`, async () => {
    // `user_stats` is fetched with `select('*')`. At phase enc that returns
    // `monthly_limit_enc` and NOT `monthly_limit`, so without a decode the route
    // returned `Number(undefined)` — NaN — as the user's overall monthly cap.
    // Nothing would have thrown.
    const { http } = await boot('dashboard');
    try {
      const { body } = await http.get('/');
      assert.equal(body.preferences.monthlyLimit, 1500);
      assert.ok(Number.isFinite(body.preferences.monthlyLimit), 'must be a real number');
    } finally {
      await http.close();
    }
  });

  test(`${label} budget alerts compute against the decoded limit`, async () => {
    // The second leftover the grep caught: a loop still reading the raw result.
    const { http } = await boot('dashboard');
    try {
      const { body } = await http.get('/');
      const alert = body.budgetAlerts.find((a) => a.categoryId === CAT);
      assert.ok(alert, 'a budget over 75% used should produce an alert entry');
      assert.equal(alert.spent, 140, '100 + 40 of countable spend');
      assert.equal(alert.limit, 100, 'the decoded limit');
      assert.ok(Number.isFinite(alert.percent));
      assert.equal(Number(alert.percent.toFixed(2)), 1.4);
      assert.equal(alert.name, 'Groceries', 'the category name decodes');
    } finally {
      await http.close();
    }
  });

  test(`${label} the recent list decodes descriptions and amounts`, async () => {
    const { http } = await boot('dashboard');
    try {
      const { body } = await http.get('/');
      assert.ok(body.recentTransactions.length > 0);
      const descriptions = body.recentTransactions.map((t) => t.description);
      assert.ok(descriptions.includes('Boots 55'), 'descriptions must be readable');
      for (const t of body.recentTransactions) {
        assert.ok(Number.isFinite(Number(t.amount)), `amount for ${t.id} must be a number`);
      }
      assertNoSilentNaN(body);
    } finally {
      await http.close();
    }
  });

  test(`${label} category breakdown uses decoded category names`, async () => {
    const { http } = await boot('dashboard');
    try {
      const { body } = await http.get('/');
      assert.ok(body.categoryBreakdown.length > 0);
      assert.equal(body.categoryBreakdown[0].name, 'Groceries');
      assert.equal(body.categoryBreakdown[0].total, 140);
      assert.equal(body.categoryBreakdown[0].percentOfExpenses, 1);
    } finally {
      await http.close();
    }
  });

  test(`${label} gamification fields still come through`, async () => {
    const { http } = await boot('dashboard');
    try {
      const { body } = await http.get('/');
      assert.equal(body.stats.currentStreak, 3);
      assert.equal(body.stats.level, 2);
      assert.equal(body.preferences.currency, 'GBP');
      assert.equal(body.preferences.displayName, 'Alex');
    } finally {
      await http.close();
    }
  });

  // --- analytics --------------------------------------------------------------

  test(`${label} analytics series is identical in every phase`, async () => {
    const { http } = await boot('analytics');
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      assert.ok(Array.isArray(body.series));

      const current = body.series.find((s) => s.ym === thisMonth());
      assert.ok(current, 'this month must be in the series');
      assert.equal(current.income, 2000);
      assert.equal(current.expenses, 140);
      assert.equal(current.net, 1860);
      assertNoSilentNaN(body);
    } finally {
      await http.close();
    }
  });

  test(`${label} analytics category totals use decoded names and amounts`, async () => {
    const { http } = await boot('analytics');
    try {
      const { body } = await http.get('/');
      const json = JSON.stringify(body);
      assert.ok(json.includes('Groceries'), 'the category name must decode');
      assertNoSilentNaN(body);
    } finally {
      await http.close();
    }
  });

  test(`${label} the special-expense toggle still excludes flagged rows`, async () => {
    const tables = await seed(phase);
    tables.user_stats[0].special_expenses_enabled = true;
    tables.transactions[1].is_special = true; // the £40 one
    const { http } = await boot('dashboard', tables);
    try {
      const { body } = await http.get('/');
      // Hero totals stay honest cash-flow — every transaction counts.
      assert.equal(body.month.expenses, 140, 'the hero total still counts everything');
      assert.equal(body.month.specialThisMonth, 40, 'and reports the special slice');
      // ...but the budget comparison excludes it.
      const alert = body.budgetAlerts.find((a) => a.categoryId === CAT);
      assert.ok(alert, 'still over 75% used even without the special row');
      assert.equal(alert.spent, 100, 'the special row is out of the budget maths');
    } finally {
      await http.close();
    }
  });
}
