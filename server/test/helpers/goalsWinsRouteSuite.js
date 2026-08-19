/**
 * The goals and wins routes, over real HTTP against a fake database, per phase.
 *
 * Both are read-heavy and both aggregate rather than returning database rows —
 * `goals.js` maps every response through `shape()`, `wins.js` builds a list of
 * named event objects. So neither needs `presentRow`; what they need is to DECODE
 * before the arithmetic, and the risk is a missed call site rather than a leak.
 *
 * `wins.js` had five downstream reads of the raw query results after the decode
 * block was added. At phase `enc` those would silently have been `undefined` and
 * every total would have read as NaN. These tests are what catch that.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const CAT = '11111111-1111-4111-8111-111111111111';
const GOAL_ID = '44444444-4444-4444-8444-444444444444';

const todayISO = () => new Date().toISOString().slice(0, 10);

async function seed(phase) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  const today = todayISO();
  return {
    savings_goals: [{
      id: GOAL_ID, user_id: U, emoji: '🏝️', target_date: '2026-12-01',
      created_at: '2026-08-01T00:00:00Z',
      ...encodeWrite('savings_goals', U, {
        name: 'Japan trip', target_amount: 2000, current_amount: 500,
      }, phase),
    }],
    savings_contributions: [{
      id: 'c1', user_id: U, goal_id: GOAL_ID, date: today, created_at: `${today}T09:00:00Z`,
      ...encodeWrite('savings_contributions', U, { amount: 100, note: 'birthday money' }, phase),
    }],
    categories: [{
      id: CAT, user_id: U, icon: '🛒', color: '#84cc16', type: 'expense',
      ...encodeWrite('categories', U, { name: 'Groceries' }, phase),
    }],
    budgets: [{
      id: 'b1', user_id: U, category_id: CAT, period: 'weekly',
      ...encodeWrite('budgets', U, { amount_limit: 100 }, phase),
    }],
    transactions: [{
      id: 't1', user_id: U, category_id: CAT, type: 'expense', date: today,
      is_special: false, created_at: `${today}T10:00:00Z`,
      ...encodeWrite('transactions', U, { amount: 40 }, phase),
    }],
    user_stats: [{
      user_id: U, currency: 'GBP', timezone: 'UTC', special_expenses_enabled: false,
      current_streak: 3, longest_streak: 5, shields: 1, last_logged_date: today,
      ...encodeWrite('user_stats', U, { monthly_limit: 1000 }, phase),
    }],
  };
}

export function runGoalsWinsRouteSuite(phase) {
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

  // --- goals -----------------------------------------------------------------

  test(`${label} goals GET / decodes name and both amounts`, async () => {
    const { http } = await boot('goals');
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      const g = body.goals[0];
      assert.equal(g.name, 'Japan trip');
      assert.equal(g.targetAmount, 2000);
      assert.equal(g.currentAmount, 500);
      assert.equal(g.percent, 0.25, 'the derived maths still works on decoded values');
      assert.equal(g.completed, false);
      assert.ok(!JSON.stringify(body).includes('_enc'));
    } finally {
      await http.close();
    }
  });

  test(`${label} goals POST / stores the encrypted columns for the phase`, async () => {
    const { db, http } = await boot('goals');
    try {
      const { status, body } = await http.send('POST', '/', {
        name: 'New laptop', targetAmount: 1200, emoji: '💻',
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.goal.name, 'New laptop');
      assert.equal(body.goal.targetAmount, 1200);

      const stored = db.store.savings_goals.at(-1);
      if (phase === 'off') {
        assert.equal(stored.name, 'New laptop');
        assert.equal(stored.name_enc, undefined);
      } else {
        assert.match(String(stored.name_enc), /^v2:/);
        assert.match(String(stored.target_amount_enc), /^v2:/);
        if (phase === 'enc') assert.equal(stored.name, undefined);
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} goals PATCH renames and re-encrypts`, async () => {
    const { db, http } = await boot('goals');
    try {
      const { status, body } = await http.send('PATCH', `/${GOAL_ID}`, { name: 'Japan 2027' });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.goal.name, 'Japan 2027');
      assert.equal(body.goal.targetAmount, 2000, 'untouched fields survive');

      const stored = db.store.savings_goals.find((r) => r.id === GOAL_ID);
      if (phase !== 'off') {
        const { decryptRegistered } = await import('../../lib/crypto.js');
        assert.equal(decryptRegistered('savings_goals.name', U, stored.name_enc), 'Japan 2027');
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: a contribution adds to the DECODED balance`, async () => {
    // The arithmetic reads current_amount and target_amount. Decoding after the
    // read rather than before would make this NaN at phase enc — silently
    // corrupting a savings balance rather than erroring.
    const { db, http } = await boot('goals');
    try {
      const { status, body } = await http.send('POST', `/${GOAL_ID}/contributions`, {
        amount: 250, note: 'bonus',
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.goal.currentAmount, 750, '500 + 250');
      assert.equal(body.goal.percent, 0.375);
      // 500/2000 was ALREADY 25%, so nothing new is crossed here.
      assert.equal(body.milestone, null);

      const contribution = db.store.savings_contributions.at(-1);
      if (phase !== 'off') {
        const { decryptRegistered } = await import('../../lib/crypto.js');
        assert.equal(decryptRegistered('savings_contributions.amount', U, contribution.amount_enc), 250);
        assert.equal(decryptRegistered('savings_contributions.note', U, contribution.note_enc), 'bonus');
      } else {
        assert.equal(contribution.amount, 250);
        assert.equal(contribution.note, 'bonus');
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} a contribution that crosses a milestone reports it`, async () => {
    // 500 -> 1050 of 2000 crosses 50%. The threshold maths runs on decoded
    // amounts, so this is a second, sharper check that the decode happens first.
    const { http } = await boot('goals');
    try {
      const { status, body } = await http.send('POST', `/${GOAL_ID}/contributions`, { amount: 550 });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.goal.currentAmount, 1050);
      assert.equal(body.milestone, 0.5, '50% was just crossed');
      assert.equal(body.justCompleted, false);
    } finally {
      await http.close();
    }
  });

  test(`${label} a contribution that finishes the goal reports completion`, async () => {
    const { http } = await boot('goals');
    try {
      const { body } = await http.send('POST', `/${GOAL_ID}/contributions`, { amount: 1500 });
      assert.equal(body.goal.currentAmount, 2000);
      assert.equal(body.goal.completed, true);
      assert.equal(body.justCompleted, true);
      assert.equal(body.milestone, 1);
    } finally {
      await http.close();
    }
  });

  test(`${label} goals DELETE and a bad id`, async () => {
    const { db, http } = await boot('goals');
    try {
      assert.equal((await http.send('DELETE', '/nope')).status, 400);
      assert.equal((await http.send('DELETE', `/${GOAL_ID}`)).status, 204);
      assert.equal(db.store.savings_goals.find((r) => r.id === GOAL_ID), undefined);
    } finally {
      await http.close();
    }
  });

  // --- wins ------------------------------------------------------------------

  test(`${label} wins GET / builds the same events in every phase`, async () => {
    const { http } = await boot('wins');
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      assert.ok(Array.isArray(body.wins));

      const streak = body.wins.find((w) => w.type === 'streak');
      assert.ok(streak, 'a 3-day streak should produce a win');
      assert.match(streak.title, /3-day streak/);

      // £100 weekly budget, £40 spent -> £60 saved. This is the number that goes
      // NaN if any downstream read still uses the un-decoded rows.
      const budget = body.wins.find((w) => w.type === 'under_budget');
      assert.ok(budget, 'staying under a weekly budget should produce a win');
      assert.match(budget.title, /Groceries/, 'the category name decodes');
      assert.match(budget.body, /60/, '100 - 40 = 60 saved');

      const savings = body.wins.find((w) => w.type === 'savings');
      assert.ok(savings, 'a recent contribution should produce a win');
      assert.ok(!JSON.stringify(body).includes('NaN'), 'no total may read as NaN');
      assert.ok(!JSON.stringify(body).includes('_enc'));
      assert.ok(!JSON.stringify(body).includes('v2:'));
    } finally {
      await http.close();
    }
  });

  test(`${label} wins respects the special-expense toggle`, async () => {
    const tables = await seed(phase);
    tables.user_stats[0].special_expenses_enabled = true;
    tables.transactions[0].is_special = true;
    const { http } = await boot('wins', tables);
    try {
      const { body } = await http.get('/');
      // With the only expense excluded, spend is 0 and the rule requires spent > 0.
      assert.equal(body.wins.find((w) => w.type === 'under_budget'), undefined);
    } finally {
      await http.close();
    }
  });
}
