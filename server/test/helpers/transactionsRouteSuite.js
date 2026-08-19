/**
 * The transactions route, over real HTTP against a fake database, once per phase.
 *
 * This is the route that tests the codec design hardest: three encrypted columns
 * (`amount`, `original_amount`, `description`), a blind index derived from one of
 * them, a second encrypted table written in the same request (`recurrences`), and
 * a foreign-currency path where the stored amount is DERIVED rather than trusted.
 *
 * Every phase must produce byte-identical JSON.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const CAT = '11111111-1111-4111-8111-111111111111';
const TX_ID = '33333333-3333-4333-8333-333333333333';

async function seed(phase) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  return {
    transactions: [{
      id: TX_ID, user_id: U, category_id: CAT, type: 'expense', date: '2026-08-05',
      is_special: false, special_group_id: null, is_recurring: false, recurrence_id: null,
      original_currency: null, fx_rate: null, created_at: '2026-08-05T10:00:00Z',
      ...encodeWrite('transactions', U, {
        amount: 12.5, description: 'Tesco Express 1234', original_amount: null,
      }, phase),
    }],
    categories: [{
      id: CAT, user_id: U, icon: '🛒', color: '#84cc16', type: 'expense',
      ...encodeWrite('categories', U, { name: 'Groceries' }, phase),
    }],
    user_stats: [{
      user_id: U, currency: 'GBP', timezone: 'UTC', special_expenses_enabled: false,
      current_streak: 3, longest_streak: 5, shields: 1, xp_points: 100, level: 2,
      last_logged_date: '2026-08-04',
      ...encodeWrite('user_stats', U, { monthly_limit: 1000 }, phase),
    }],
    recurrences: [],
    special_groups: [],
  };
}

export function runTransactionsRouteSuite(phase) {
  const label = `[phase=${phase}]`;

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
      mock.module('../../lib/supabase.js', { exports: { supabase: supabaseProxy } });
      mocked = true;
    }
    const { default: router } = await import('../../routes/transactions.js');
    const http = await serve(router, { userId: U, mountAt: '/api/transactions' });
    return { db: currentDb, http };
  }

  test(`${label} GET / returns decoded transactions`, async () => {
    const { http } = await boot();
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.transactions.length, 1);
      const t = body.transactions[0];
      assert.equal(t.amount, 12.5);
      assert.equal(t.description, 'Tesco Express 1234');
      assert.equal(t.type, 'expense');
      assert.equal(t.date, '2026-08-05');
    } finally {
      await http.close();
    }
  });

  test(`${label} GET / leaks no ciphertext, blind index or user id`, async () => {
    const { http } = await boot();
    try {
      const { body } = await http.get('/');
      const json = JSON.stringify(body);
      for (const forbidden of ['_enc', 'v2:', '_hmac', 'merchant_prefix', U]) {
        assert.ok(!json.includes(forbidden), `response must not contain ${forbidden}`);
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} POST / stores the right columns and returns them decoded`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('POST', '/', {
        categoryId: CAT, amount: 42.75, type: 'expense', description: 'Boots 55', date: '2026-08-10',
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.transaction.amount, 42.75);
      assert.equal(body.transaction.description, 'Boots 55');
      assert.ok(!JSON.stringify(body).includes('_enc'));

      const stored = db.store.transactions.at(-1);
      if (phase === 'off') {
        assert.equal(stored.amount, 42.75);
        assert.equal(stored.description, 'Boots 55');
        assert.equal(stored.amount_enc, undefined);
        assert.equal(stored.merchant_prefix_hmacs, undefined, 'off writes no blind index');
      } else {
        assert.match(String(stored.amount_enc), /^v2:/);
        assert.match(String(stored.description_enc), /^v2:/);
        assert.ok(Array.isArray(stored.merchant_prefix_hmacs), 'the blind index must be written');
        if (phase === 'dual') assert.equal(stored.description, 'Boots 55');
        if (phase === 'enc') assert.equal(stored.description, undefined);
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: editing a description rewrites its blind index`, async () => {
    // The failure this prevents is silent and permanent: merchant memory stops
    // matching, and after migration 019 the plaintext is gone so the index can
    // never be recomputed. Going through encodeWrite makes it impossible to
    // update one without the other.
    const { db, http } = await boot();
    try {
      const before = db.store.transactions.find((r) => r.id === TX_ID).merchant_prefix_hmacs;
      const { status } = await http.send('PATCH', `/${TX_ID}`, { description: 'Boots 55' });
      assert.equal(status, 200);

      const stored = db.store.transactions.find((r) => r.id === TX_ID);
      if (phase === 'off') {
        assert.equal(stored.description, 'Boots 55');
        return; // no index exists yet at this phase
      }

      const { blindIndexMany } = await import('../../lib/crypto.js');
      const { merchantPrefixes } = await import('../../lib/merchant.js');
      assert.deepEqual(
        stored.merchant_prefix_hmacs,
        blindIndexMany('transactions.merchant_prefix_hmacs', U, merchantPrefixes('Boots 55')),
        'the index must match the NEW description',
      );
      assert.notDeepEqual(stored.merchant_prefix_hmacs, before, 'and must have actually changed');
    } finally {
      await http.close();
    }
  });

  test(`${label} an amount-only edit leaves the description and its index alone`, async () => {
    const { db, http } = await boot();
    try {
      const before = { ...db.store.transactions.find((r) => r.id === TX_ID) };
      const { status, body } = await http.send('PATCH', `/${TX_ID}`, { amount: 99.99 });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.transaction.amount, 99.99);
      assert.equal(body.transaction.description, 'Tesco Express 1234', 'unchanged');

      const stored = db.store.transactions.find((r) => r.id === TX_ID);
      assert.deepEqual(stored.merchant_prefix_hmacs, before.merchant_prefix_hmacs);
      if (phase !== 'off') assert.equal(stored.description_enc, before.description_enc);
    } finally {
      await http.close();
    }
  });

  test(`${label} a foreign-currency entry encrypts BOTH amounts`, async () => {
    // amount = original_amount x fx_rate, so encrypting only one leaves the other
    // recoverable by a single multiplication — the exact hole migration 016 opened.
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('POST', '/', {
        // `amount` still has to satisfy the schema, but the server IGNORES it and
        // derives the stored figure from original x rate — which is what the
        // assertion below actually checks.
        categoryId: CAT, amount: 1, type: 'expense', description: 'Cafe Paris',
        foreign: { originalAmount: 20, originalCurrency: 'EUR', fxRate: 0.85 },
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.transaction.original_amount, 20);
      assert.equal(body.transaction.original_currency, 'EUR');
      assert.equal(body.transaction.amount, 17, '20 x 0.85, derived by the server');

      const stored = db.store.transactions.at(-1);
      if (phase !== 'off') {
        assert.match(String(stored.amount_enc), /^v2:/);
        assert.match(String(stored.original_amount_enc), /^v2:/, 'original_amount must be encrypted too');
        // fx_rate stays plaintext on purpose — a public market rate, and it keeps
        // the fx_rate > 0 CHECK enforceable in the database.
        assert.equal(stored.fx_rate, 0.85);
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} an opt-in recurring schedule encrypts the recurrences row too`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('POST', '/', {
        categoryId: CAT, amount: 9.99, type: 'expense', description: 'Netflix',
        date: '2026-08-10', recurring: { interval: 'monthly' },
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.recurrence.amount, 9.99, 'the response reads the decoded amount');
      assert.equal(body.transaction.is_recurring, true);

      const rec = db.store.recurrences.at(-1);
      if (phase === 'off') {
        assert.equal(rec.amount, 9.99);
        assert.equal(rec.description, 'Netflix');
      } else {
        assert.match(String(rec.amount_enc), /^v2:/, 'recurrences.amount is encrypted');
        assert.match(String(rec.description_enc), /^v2:/, 'so is its description');
      }
      assert.ok(!JSON.stringify(body).includes('_enc'));
    } finally {
      await http.close();
    }
  });

  test(`${label} clearing a description stores null on both halves`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('PATCH', `/${TX_ID}`, { description: null });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.transaction.description, null);

      const stored = db.store.transactions.find((r) => r.id === TX_ID);
      if (phase !== 'off') {
        assert.equal(stored.description_enc, null, 'a cleared value must clear the ciphertext');
        assert.equal(stored.merchant_prefix_hmacs, null, 'and its index');
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} DELETE removes the row, and a bad id is a 400`, async () => {
    const { db, http } = await boot();
    try {
      assert.equal((await http.send('DELETE', '/not-a-uuid')).status, 400);
      assert.equal((await http.send('DELETE', `/${TX_ID}`)).status, 204);
      assert.equal(db.store.transactions.find((r) => r.id === TX_ID), undefined);
    } finally {
      await http.close();
    }
  });

  test(`${label} logging still awards XP and extends the streak`, async () => {
    // Gamification writes only its own columns, none of them encrypted — pinned
    // here so the sweep cannot quietly disturb it.
    const { db, http } = await boot();
    try {
      const { body } = await http.send('POST', '/', {
        categoryId: CAT, amount: 5, type: 'expense', clientToday: '2026-08-05',
      });
      assert.ok(body.delta.awardedXp > 0);
      assert.equal(body.delta.streakExtended, true, '2026-08-04 -> 2026-08-05');
      const stats = db.store.user_stats[0];
      assert.equal(stats.current_streak, 4);
      assert.equal(stats.last_logged_date, '2026-08-05');
    } finally {
      await http.close();
    }
  });
}
