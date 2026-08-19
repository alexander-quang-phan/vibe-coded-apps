/**
 * The budgets route, exercised over real HTTP against a fake database.
 *
 * Run once per ENCRYPTION_PHASE from a thin wrapper test file. **Every phase must
 * produce byte-identical JSON** — that is the whole promise of Part A, and the
 * only thing that makes the sweep safe to ship before a key exists.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const CAT = '11111111-1111-4111-8111-111111111111';
// A real uuid: routes/budgets.js validates the :id param before touching the db.
const BUDGET_ID = '22222222-2222-4222-8222-222222222222';

/** The fixture, written the way the app would write it for the phase under test. */
async function seed(phase) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  const month = new Date().toISOString().slice(0, 7);
  return {
    budgets: [{
      id: BUDGET_ID, user_id: U, category_id: CAT, period: 'monthly', created_at: '2026-08-01T00:00:00Z',
      ...encodeWrite('budgets', U, { amount_limit: 200 }, phase),
    }],
    categories: [{
      id: CAT, user_id: U, icon: '🛒', color: '#84cc16', type: 'expense',
      ...encodeWrite('categories', U, { name: 'Groceries' }, phase),
    }],
    transactions: [
      { id: 't1', user_id: U, category_id: CAT, type: 'expense', date: `${month}-05`, is_special: false,
        ...encodeWrite('transactions', U, { amount: 30 }, phase) },
      { id: 't2', user_id: U, category_id: CAT, type: 'expense', date: `${month}-06`, is_special: false,
        ...encodeWrite('transactions', U, { amount: 20.5 }, phase) },
    ],
    user_stats: [{
      user_id: U, special_expenses_enabled: false, timezone: 'UTC',
      ...encodeWrite('user_stats', U, { monthly_limit: 1000 }, phase),
    }],
  };
}

export function runBudgetsRouteSuite(phase) {
  const label = `[phase=${phase}]`;

  // A module can only be mocked ONCE per process, so the mock is installed once
  // and points at a holder that each test swaps. `lib/userZone.js` imports
  // supabase separately and reaches the same fake through it.
  let currentDb = null;
  let mocked = false;
  const supabaseProxy = {
    from: (t) => currentDb.from(t),
    rpc: (...args) => currentDb.rpc(...args),
  };

  async function boot(tables) {
    const { fakeSupabase, serve } = await import('./routeHarness.js');
    currentDb = fakeSupabase(tables ?? (await seed(phase)));
    if (!mocked) {
      // Resolved relative to THIS file, so two levels up to server/lib.
      mock.module('../../lib/supabase.js', { exports: { supabase: supabaseProxy } });
      mocked = true;
    }
    const { default: router } = await import('../../routes/budgets.js');
    const http = await serve(router, { userId: U, mountAt: '/api/budgets' });
    return { db: currentDb, http };
  }

  test(`${label} GET / returns the same JSON in every phase`, async () => {
    const { http } = await boot();
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));

      assert.equal(body.budgets.length, 1);
      const b = body.budgets[0];
      assert.equal(b.limit, 200, 'the decoded budget limit');
      assert.equal(b.spent, 50.5, '30 + 20.5 of countable spend');
      assert.equal(b.category.name, 'Groceries', 'category names decode too');
      assert.equal(Number(b.percent.toFixed(4)), Number((50.5 / 200).toFixed(4)));

      assert.equal(body.overall.limit, 1000, 'user_stats.monthly_limit decodes');
      assert.equal(body.overall.spent, 50.5);
    } finally {
      await http.close();
    }
  });

  test(`${label} no ciphertext or _enc column ever reaches the client`, async () => {
    const { http } = await boot();
    try {
      const { body } = await http.get('/');
      const json = JSON.stringify(body);
      assert.ok(!json.includes('_enc'), 'no ciphertext column name in the response');
      assert.ok(!json.includes('v2:'), 'no envelope in the response');
      assert.ok(!json.includes('_hmac'), 'no blind index in the response');
      assert.ok(!json.includes(U), 'no user id echoed back');
    } finally {
      await http.close();
    }
  });

  test(`${label} POST / creates a budget and returns it decoded`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('POST', '/', {
        categoryId: CAT, amountLimit: 75.25, period: 'weekly',
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.budget.amount_limit, 75.25);
      assert.equal(body.budget.period, 'weekly');
      assert.ok(!('amount_limit_enc' in body.budget), 'ciphertext must not be serialised');

      // And what actually landed in the table matches the phase.
      const stored = db.store.budgets.at(-1);
      if (phase === 'off') {
        assert.equal(stored.amount_limit, 75.25);
        assert.equal(stored.amount_limit_enc, undefined, 'off must write no ciphertext');
      } else if (phase === 'dual') {
        assert.equal(stored.amount_limit, 75.25, 'dual keeps the plaintext');
        assert.match(String(stored.amount_limit_enc), /^v2:/, 'dual also writes ciphertext');
      } else {
        assert.equal(stored.amount_limit, undefined, 'enc must not write the dropped column');
        assert.match(String(stored.amount_limit_enc), /^v2:/);
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} PATCH /:id updates the limit and returns it decoded`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('PATCH', `/${BUDGET_ID}`, { amountLimit: 300 });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.budget.amount_limit, 300);

      const stored = db.store.budgets.find((r) => r.id === BUDGET_ID);
      if (phase !== 'enc') assert.equal(stored.amount_limit, 300);
      if (phase !== 'off') {
        const { decryptRegistered } = await import('../../lib/crypto.js');
        assert.equal(decryptRegistered('budgets.amount_limit', U, stored.amount_limit_enc), 300,
          'the ciphertext must be rewritten too, or the gate will call it stale');
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} PATCH of a missing budget is a 404, not a crash`, async () => {
    const { http } = await boot();
    try {
      const { status } = await http.send('PATCH', '/99999999-9999-4999-8999-999999999999', { amountLimit: 5 });
      assert.equal(status, 404);
    } finally {
      await http.close();
    }
  });

  test(`${label} DELETE /:id removes the row`, async () => {
    const { db, http } = await boot();
    try {
      const { status } = await http.send('DELETE', `/${BUDGET_ID}`);
      assert.equal(status, 204);
      assert.equal(db.store.budgets.find((r) => r.id === BUDGET_ID), undefined);
    } finally {
      await http.close();
    }
  });

  test(`${label} a special-flagged expense is excluded when the toggle is on`, async () => {
    // Pure regression on behaviour the sweep must not disturb.
    const tables = await seed(phase);
    tables.user_stats[0].special_expenses_enabled = true;
    tables.transactions[1].is_special = true;
    const { http } = await boot(tables);
    try {
      const { body } = await http.get('/');
      assert.equal(body.budgets[0].spent, 30, 'the special expense is not counted');
    } finally {
      await http.close();
    }
  });
}
