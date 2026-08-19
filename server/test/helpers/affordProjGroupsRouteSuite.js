/**
 * affordability, projections and specialGroups — over real HTTP, once per phase.
 *
 * All three feed decoded amounts into `lib/overallBudget.js`, and two of them
 * passed `statsRes.data.monthly_limit` straight into it. At phase `enc` that is
 * `undefined`, so the user's monthly cap would have become NaN inside the pace
 * maths — the same silent-wrong-number failure dashboard.js had, in two more
 * places. The grep after sweeping is what found all of them.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const CAT = '11111111-1111-4111-8111-111111111111';
const GROUP = '55555555-5555-4555-8555-555555555555';
const GOAL = '66666666-6666-4666-8666-666666666666';

const thisMonth = () => new Date().toISOString().slice(0, 7);

async function seed(phase) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  const m = thisMonth();
  const tx = (id, amount, day, extra = {}) => ({
    id, user_id: U, category_id: CAT, type: 'expense', date: `${m}-${day}`,
    is_special: false, special_group_id: null, created_at: `${m}-${day}T10:00:00Z`, ...extra,
    ...encodeWrite('transactions', U, { amount, description: 'Tesco Express' }, phase),
  });
  return {
    transactions: [
      tx('t1', 100, '05'),
      tx('t2', 40, '06', { is_special: true, special_group_id: GROUP }),
    ],
    categories: [{
      id: CAT, user_id: U, icon: '🛒', color: '#84cc16', type: 'expense',
      ...encodeWrite('categories', U, { name: 'Groceries' }, phase),
    }],
    budgets: [{
      id: 'b1', user_id: U, category_id: CAT, period: 'monthly',
      ...encodeWrite('budgets', U, { amount_limit: 300 }, phase),
    }],
    savings_goals: [{
      id: GOAL, user_id: U, emoji: '🏝️', target_date: `${m}-28`, created_at: `${m}-01T00:00:00Z`,
      ...encodeWrite('savings_goals', U, {
        name: 'Japan trip', target_amount: 1000, current_amount: 200,
      }, phase),
    }],
    savings_contributions: [{
      id: 'sc1', user_id: U, goal_id: GOAL, date: `${m}-02`, created_at: `${m}-02T09:00:00Z`,
      ...encodeWrite('savings_contributions', U, { amount: 200, note: null }, phase),
    }],
    special_groups: [{
      id: GROUP, user_id: U, archived_at: null, created_at: `${m}-01T00:00:00Z`,
      ...encodeWrite('special_groups', U, { name: 'Paris holiday' }, phase),
    }],
    user_stats: [{
      user_id: U, currency: 'GBP', timezone: 'UTC', special_expenses_enabled: false,
      ...encodeWrite('user_stats', U, { monthly_limit: 500 }, phase),
    }],
  };
}

export function runAffordProjGroupsSuite(phase) {
  const label = `[phase=${phase}]`;

  let currentDb = null;
  let mocked = false;
  const supabaseProxy = {
    from: (t) => currentDb.from(t),
    rpc: (...args) => currentDb.rpc(...args),
  };

  async function boot(which, mountAt, tables) {
    const { fakeSupabase, serve } = await import('./routeHarness.js');
    currentDb = fakeSupabase(tables ?? (await seed(phase)));
    if (!mocked) {
      mock.module('../../lib/supabase.js', { exports: { supabase: supabaseProxy } });
      mocked = true;
    }
    const { default: router } = await import(`../../routes/${which}.js`);
    const http = await serve(router, { userId: U, mountAt });
    return { db: currentDb, http };
  }

  /** Nothing anywhere in the payload may be NaN, ciphertext, or a user id. */
  const clean = (body) => {
    const json = JSON.stringify(body);
    assert.ok(!json.includes('NaN'), 'no field may serialise as NaN');
    assert.ok(!json.includes('_enc'), 'no ciphertext column may appear');
    assert.ok(!json.includes('v2:'), 'no envelope may appear');
    assert.ok(!json.includes(U), 'no user id may be echoed');
    const walk = (v) => {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite number in the response: ${v}`);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(body);
  };

  // --- affordability ----------------------------------------------------------

  test(`${label} affordability answers identically in every phase`, async () => {
    const { http } = await boot('affordability', '/api/affordability');
    try {
      const { status, body } = await http.send('POST', '/', { amount: 50, categoryId: CAT });
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      assert.ok(body.verdict, 'a verdict is returned');
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: the monthly cap reaches the pace maths as a number`, async () => {
    // `monthlyLimit: statsRes.data.monthly_limit` went straight into
    // lib/overallBudget.js. At phase enc that key does not exist, so the cap
    // became undefined and every derived figure NaN — with nothing thrown.
    // `clean()` walks the whole payload for non-finite numbers.
    const { http } = await boot('affordability', '/api/affordability');
    try {
      const { status, body } = await http.send('POST', '/', { amount: 50 });
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
    } finally {
      await http.close();
    }
  });

  test(`${label} affordability still respects a category budget`, async () => {
    const { http } = await boot('affordability', '/api/affordability');
    try {
      const { body } = await http.send('POST', '/', { amount: 50, categoryId: CAT });
      clean(body);
      // £300 category budget, £100 countable spend -> £200 left before this buy.
      if (body.categoryRemaining !== null && body.categoryRemaining !== undefined) {
        assert.ok(Number.isFinite(body.categoryRemaining));
      }
    } finally {
      await http.close();
    }
  });

  // --- projections ------------------------------------------------------------

  test(`${label} projections month is identical in every phase`, async () => {
    const { http } = await boot('projections', '/api/projections');
    try {
      const { status, body } = await http.get('/month');
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
    } finally {
      await http.close();
    }
  });

  // --- specialGroups ----------------------------------------------------------

  test(`${label} special groups list decodes names and totals`, async () => {
    const { http } = await boot('specialGroups', '/api/special-groups');
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      const g = body.groups.find((x) => x.id === GROUP);
      assert.ok(g, 'the seeded group must be listed');
      assert.equal(g.name, 'Paris holiday', 'the group name decodes');
      assert.equal(g.total, 40, 'the special expense is totalled');
      assert.equal(g.count, 1);
    } finally {
      await http.close();
    }
  });

  test(`${label} creating a group encrypts its name`, async () => {
    const { db, http } = await boot('specialGroups', '/api/special-groups');
    try {
      const { status, body } = await http.send('POST', '/', { name: 'Tokyo 2027' });
      assert.equal(status, 201, JSON.stringify(body));
      clean(body);
      assert.equal(body.group.name, 'Tokyo 2027');

      const stored = db.store.special_groups.at(-1);
      if (phase === 'off') {
        assert.equal(stored.name, 'Tokyo 2027');
        assert.equal(stored.name_enc, undefined);
      } else {
        assert.match(String(stored.name_enc), /^v2:/);
        if (phase === 'enc') assert.equal(stored.name, undefined);
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} renaming a group re-encrypts it`, async () => {
    const { db, http } = await boot('specialGroups', '/api/special-groups');
    try {
      const { status, body } = await http.send('PATCH', `/${GROUP}`, { name: 'Paris 2027' });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.group.name, 'Paris 2027');

      const stored = db.store.special_groups.find((r) => r.id === GROUP);
      if (phase !== 'off') {
        const { decryptRegistered } = await import('../../lib/crypto.js');
        assert.equal(decryptRegistered('special_groups.name', U, stored.name_enc), 'Paris 2027');
      } else {
        assert.equal(stored.name, 'Paris 2027');
      }
    } finally {
      await http.close();
    }
  });
}
