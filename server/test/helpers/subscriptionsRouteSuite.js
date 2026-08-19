/**
 * The subscriptions route — the one the codec alone could not finish.
 *
 * `subscription_overrides.merchant_key` is encrypted AND is the table's primary
 * key, and migration 019 moves that key onto `merchant_key_hmac`. So this route
 * has to follow the phase in two places the codec knows nothing about: the
 * equality lookup, and the upsert's conflict target. Getting either wrong is
 * silent — the lookup simply finds nothing, and the upsert quietly inserts a
 * duplicate instead of updating.
 *
 * These tests therefore check the STORED rows as well as the responses.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const CAT = '11111111-1111-4111-8111-111111111111';
const REC = '77777777-7777-4777-8777-777777777777';
const KEY = 'netflix';

async function seed(phase) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  return {
    subscription_overrides: [{
      user_id: U, status: 'active', decided_at: '2026-08-01T00:00:00Z',
      ...encodeWrite('subscription_overrides', U, {
        merchant_key: KEY, display_name: 'Netflix',
      }, phase),
    }],
    transactions: [],
    categories: [{
      id: CAT, user_id: U, icon: '🎬', color: '#f59e0b', type: 'expense',
      ...encodeWrite('categories', U, { name: 'Entertainment' }, phase),
    }],
    recurrences: [{
      id: REC, user_id: U, category_id: CAT, type: 'expense', interval: 'monthly',
      next_run_at: '2026-09-01', last_run_at: null, cancelled_at: null,
      created_at: '2026-08-01T00:00:00Z',
      ...encodeWrite('recurrences', U, { amount: 9.99, description: 'Netflix' }, phase),
    }],
    user_stats: [{ user_id: U, currency: 'GBP', timezone: 'UTC', special_expenses_enabled: false }],
  };
}

export function runSubscriptionsRouteSuite(phase) {
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
    const { default: router } = await import('../../routes/subscriptions.js');
    const http = await serve(router, { userId: U, mountAt: '/api/subscriptions' });
    return { db: currentDb, http };
  }

  const clean = (body) => {
    const json = JSON.stringify(body);
    assert.ok(!json.includes('_enc'), 'no ciphertext column may appear');
    assert.ok(!json.includes('v2:'), 'no envelope may appear');
    assert.ok(!json.includes('_hmac'), 'no blind index may appear');
    assert.ok(!json.includes('NaN'), 'no field may serialise as NaN');
  };

  test(`${label} GET / lists manual recurrences with decoded amounts`, async () => {
    const { http } = await boot();
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      const manual = body.subscriptions.find((s) => s.merchantKey?.startsWith('manual:'));
      assert.ok(manual, 'the seeded recurrence should surface as a manual subscription');
      assert.equal(manual.amount, 9.99, 'the recurrence amount decodes');
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: an override is FOUND by its key in every phase`, async () => {
    // The lookup is `.eq('merchant_key', …)` before 019 and
    // `.eq('merchant_key_hmac', …)` after it. Get that wrong and the read simply
    // returns nothing — so the upsert below silently creates a SECOND row
    // instead of updating the existing one, and the user's dismissal is lost.
    const { db, http } = await boot();
    try {
      const before = db.store.subscription_overrides.length;
      const { status, body } = await http.send('PATCH', `/${KEY}`, { status: 'dismissed' });
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);

      assert.equal(body.override.merchantKey, KEY, 'the key round-trips decoded');
      assert.equal(body.override.status, 'dismissed');
      assert.equal(
        body.override.displayName, 'Netflix',
        'the EXISTING display name was found and preserved — proof the lookup matched',
      );
      assert.equal(
        db.store.subscription_overrides.length, before,
        'the upsert must UPDATE the existing row, not insert a duplicate',
      );
    } finally {
      await http.close();
    }
  });

  test(`${label} the stored override carries the right columns for the phase`, async () => {
    const { db, http } = await boot();
    try {
      await http.send('PATCH', `/${KEY}`, { status: 'dismissed' });
      const stored = db.store.subscription_overrides[0];
      if (phase === 'off') {
        assert.equal(stored.merchant_key, KEY);
        assert.equal(stored.merchant_key_hmac, undefined, 'no index before the columns exist');
      } else {
        const { blindIndex, decryptRegistered } = await import('../../lib/crypto.js');
        assert.equal(
          stored.merchant_key_hmac,
          blindIndex('subscription_overrides.merchant_key_hmac', U, KEY),
          'the blind index must be written — it becomes the primary key at 019',
        );
        assert.equal(
          decryptRegistered('subscription_overrides.merchant_key', U, stored.merchant_key_enc), KEY,
          'and an ENCRYPTED copy must exist, or a key rotation could never rebuild the key',
        );
        if (phase === 'enc') assert.equal(stored.merchant_key, undefined);
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} setting a display name encrypts it and returns it decoded`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('PATCH', `/${KEY}`, { displayName: 'Netflix UK' });
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      assert.equal(body.override.displayName, 'Netflix UK');

      const stored = db.store.subscription_overrides[0];
      if (phase === 'off') assert.equal(stored.display_name, 'Netflix UK');
      else {
        const { decryptRegistered } = await import('../../lib/crypto.js');
        assert.equal(
          decryptRegistered('subscription_overrides.display_name', U, stored.display_name_enc),
          'Netflix UK',
        );
      }
    } finally {
      await http.close();
    }
  });

  test(`${label} a first-time override for an unknown key inserts one row`, async () => {
    const { db, http } = await boot();
    try {
      const before = db.store.subscription_overrides.length;
      const { status, body } = await http.send('PATCH', '/spotify', { status: 'dismissed' });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.override.merchantKey, 'spotify');
      assert.equal(db.store.subscription_overrides.length, before + 1);
    } finally {
      await http.close();
    }
  });

  test(`${label} cancelling a manual recurrence decodes its amount back`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('PATCH', `/manual:${REC}`, { status: 'cancelled' });
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      assert.equal(body.recurrence.status, 'cancelled');
      assert.equal(body.recurrence.amount, 9.99, 'the amount must survive the round trip');
      assert.ok(db.store.recurrences.find((r) => r.id === REC).cancelled_at);
    } finally {
      await http.close();
    }
  });

  test(`${label} editing a manual recurrence amount re-encrypts it`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('PATCH', `/manual:${REC}`, {
        status: 'active', amount: 12.99,
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.recurrence.amount, 12.99);

      const stored = db.store.recurrences.find((r) => r.id === REC);
      if (phase === 'off') assert.equal(stored.amount, 12.99);
      else {
        const { decryptRegistered } = await import('../../lib/crypto.js');
        assert.equal(decryptRegistered('recurrences.amount', U, stored.amount_enc), 12.99);
      }
    } finally {
      await http.close();
    }
  });
}
