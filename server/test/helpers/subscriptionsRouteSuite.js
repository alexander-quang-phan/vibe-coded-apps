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
      id: REC, user_id: U, category_id: CAT, type: 'expense', interval: 'monthly', auto_log: true,
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

  async function boot(tables, opts) {
    const { fakeSupabase, serve } = await import('./routeHarness.js');
    currentDb = fakeSupabase(tables ?? (await seed(phase)), opts);
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

  // ===========================================================================
  // Phase 17 — subscriptions Alex marks himself (tracked, never auto-logged)
  // ===========================================================================

  const U2 = '00000000-0000-4000-8000-000000000002';
  const OTHER_CAT = '22222222-2222-4222-8222-222222222222';
  const T_REC = '55555555-5555-4555-8555-555555555555';
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  async function txRow({ n, date, amount, description = null, rec = null, user = U, cat = CAT, type = 'expense' }) {
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    return {
      id: id(n), user_id: user, category_id: cat, type, date, is_recurring: false,
      recurrence_id: rec, created_at: `${date}T09:00:00Z`,
      ...encodeWrite('transactions', user, { amount, description }, phase),
    };
  }
  async function trackedRec({ rid = T_REC, description = 'Netflix', amount = 10.99, interval = 'monthly', cancelled_at = null, user = U, cat = CAT } = {}) {
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    return {
      id: rid, user_id: user, category_id: cat, type: 'expense', interval, auto_log: false,
      next_run_at: null, last_run_at: null, cancelled_at, created_at: '2026-08-01T00:00:00Z',
      ...encodeWrite('recurrences', user, { amount, description }, phase),
    };
  }
  async function tables({ recurrences = [], transactions = [] } = {}) {
    const base = await seed(phase);
    return { ...base, subscription_overrides: [], recurrences: [...base.recurrences, ...recurrences], transactions };
  }
  const sub = (body, key) => body.subscriptions.find((x) => x.merchantKey === key);
  const autoRows = (body) => body.subscriptions.filter((x) => x.source === 'auto');

  test(`${label} GET: a tracked row is DERIVED from its charges, and follows an edited charge`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ amount: 9.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-08-03', amount: 9.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-09-03', amount: 12.99, description: 'Netflix', rec: T_REC }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      let { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      const row = sub(body, `manual:${T_REC}`);
      assert.equal(row.tracking, true);
      assert.equal(row.amount, 12.99, 'amount = the latest charge, not the stored 9.99');
      assert.equal(row.lastCharged, '2026-09-03');
      assert.equal(row.nextExpected, '2026-10-03');
      assert.equal(row.occurrences, 2);
      assert.equal(row.totalPaid, 22.98);
      const repeat = sub(body, `manual:${REC}`);
      assert.equal(repeat.tracking, false, 'the seeded Repeat-this row is NOT tracked');
      assert.equal(repeat.nextExpected, '2026-09-01', 'Repeat-this keeps its stored next_run_at');

      // Fix a typo'd charge: the figure follows, because nothing was stored.
      const { encodeWrite } = await import('../../lib/encryptionCodec.js');
      Object.assign(db.store.transactions.find((r) => r.id === id(2)),
        encodeWrite('transactions', U, { amount: 10.99 }, phase));
      ({ body } = await http.get('/'));
      assert.equal(sub(body, `manual:${T_REC}`).amount, 10.99);
    } finally {
      await http.close();
    }
  });

  test(`${label} GET: a tracked row with ZERO charges returns 200 with null dates and the stored amount`, async () => {
    const { http } = await boot(await tables({ recurrences: [await trackedRec({ amount: 7.5 })] }));
    try {
      const { status, body } = await http.get('/');
      assert.equal(status, 200, JSON.stringify(body));
      const row = sub(body, `manual:${T_REC}`);
      assert.equal(row.lastCharged, null);
      assert.equal(row.nextExpected, null);
      assert.equal(row.amount, 7.5);
      assert.equal(row.occurrences, 0);
    } finally {
      await http.close();
    }
  });

  test(`${label} GET: a yearly subscription is costed per year, not as weekly`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Amazon Prime', amount: 95, interval: 'annual' })],
      transactions: [await txRow({ n: 1, date: '2026-02-10', amount: 95, description: 'Amazon Prime', rec: T_REC })],
    });
    const { http } = await boot(t);
    try {
      const row = sub((await http.get('/')).body, `manual:${T_REC}`);
      assert.equal(row.monthlyCost, 7.92);
      assert.equal(row.annualCost, 95);
      assert.equal(row.cadence, 'annual');
    } finally {
      await http.close();
    }
  });

  const monthly = async (start, description, amount, cat = CAT) => [
    await txRow({ n: start, date: '2026-07-05', amount, description, cat }),
    await txRow({ n: start + 1, date: '2026-08-04', amount, description, cat }),
    await txRow({ n: start + 2, date: '2026-09-03', amount, description, cat }),
  ];

  test(`${label} GET: a detected row with the tracked row's exact note is hidden (one row, not two)`, async () => {
    const t = await tables({
      recurrences: [await trackedRec()],
      transactions: [
        await txRow({ n: 9, date: '2026-10-03', amount: 10.99, description: 'Netflix', rec: T_REC }),
        ...(await monthly(10, 'Netflix', 10.99)),
      ],
    });
    const { http } = await boot(t);
    try {
      const { body } = await http.get('/');
      assert.equal(autoRows(body).length, 0, 'the unattached Netflix charges do not form a second row');
    } finally {
      await http.close();
    }
  });

  test(`${label} GET: tracked "Apple Music" never hides a detected "Apple TV" — or iCloud noted "Apple"`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Apple Music', amount: 10.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-09-03', amount: 10.99, description: 'Apple Music', rec: T_REC }),
        // attached through a weak offer — absorbed, but never silent
        await txRow({ n: 2, date: '2026-10-03', amount: 10.99, description: 'Apple', rec: T_REC }),
        ...(await monthly(10, 'Apple TV', 8.99)),
        ...(await monthly(20, 'Apple', 8.99)),
      ],
    });
    const { http } = await boot(t);
    try {
      const keys = autoRows((await http.get('/')).body).map((r) => r.merchantKey).sort();
      assert.deepEqual(keys, ['apple', 'apple tv']);
    } finally {
      await http.close();
    }
  });

  test(`${label} GET: a no-note tracked row never hides an inferred row (shown twice, never guessed)`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ description: null, amount: 10.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, rec: T_REC }),
        ...(await monthly(10, null, 10.99)),
      ],
    });
    const { http } = await boot(t);
    try {
      const auto = autoRows((await http.get('/')).body);
      assert.equal(auto.length, 1, 'the accepted, visible duplicate');
      assert.ok(auto[0].merchantKey.startsWith('auto:'));
    } finally {
      await http.close();
    }
  });

  test(`${label} GET: cancelling keeps its old charges hidden; a charge after the cancellation brings it back`, async () => {
    const recs = [await trackedRec({ cancelled_at: '2026-09-20T12:00:00Z' })];
    const pre = await monthly(10, 'Netflix', 10.99);
    const { http } = await boot(await tables({ recurrences: recs, transactions: pre }));
    try {
      assert.equal(autoRows((await http.get('/')).body).length, 0, 'Per month does not get the cancelled service back');
    } finally {
      await http.close();
    }
    const post = [...pre, await txRow({ n: 30, date: '2026-10-03', amount: 10.99, description: 'Netflix' })];
    const second = await boot(await tables({ recurrences: [await trackedRec({ cancelled_at: '2026-09-20T12:00:00Z' })], transactions: post }));
    try {
      const auto = autoRows((await second.http.get('/')).body);
      assert.equal(auto.length, 1, 'a post-cancellation charge means it is back');
    } finally {
      await second.http.close();
    }
  });

  test(`${label} GET: reads every expense past a silent max-rows cap (paging), same-day rows included`, async () => {
    const charges = [];
    for (let i = 0; i < 7; i += 1) {
      charges.push(await txRow({ n: 100 + i, date: '2026-09-03', amount: 1, description: 'Coffee', rec: T_REC }));
    }
    const t = await tables({ recurrences: [await trackedRec({ description: 'Coffee', amount: 1 })], transactions: charges });
    const { db, http } = await boot(t, { maxRows: 3 });
    try {
      const row = sub((await http.get('/')).body, `manual:${T_REC}`);
      assert.equal(row.occurrences, 7, 'all seven same-day charges, none skipped or repeated');
      const txReads = db.calls.filter((c) => c.table === 'transactions' && c.op === 'select');
      assert.ok(txReads.some((c) => c.orders.map((o) => o.c).join(',') === 'date,id'), 'ordered by date then id');
    } finally {
      await http.close();
    }
  });

  test(`${label} PATCH: a tracked row's amount cannot be edited (it follows the latest charge)`, async () => {
    const { http } = await boot(await tables({ recurrences: [await trackedRec()] }));
    try {
      const { status } = await http.send('PATCH', `/manual:${T_REC}`, { amount: 12 });
      assert.equal(status, 400);
      const ok = await http.send('PATCH', `/manual:${T_REC}`, { status: 'cancelled' });
      assert.equal(ok.status, 200, 'cancelling still works');
    } finally {
      await http.close();
    }
  });

  // --- preview ------------------------------------------------------------------

  test(`${label} preview: an exact note offers the tracked subscription, using the dialog's typed values`, async () => {
    const t = await tables({
      recurrences: [await trackedRec()],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-11-03', amount: 10.99, description: 'Netflx' }), // typo, fixed in the dialog
      ],
    });
    const { http } = await boot(t);
    try {
      const before = await http.get(`/track/preview?transactionId=${id(2)}`);
      assert.equal(before.body.existing, null, 'the saved typo does not match');
      const { status, body } = await http.get(`/track/preview?transactionId=${id(2)}&description=Netflix`);
      assert.equal(status, 200, JSON.stringify(body));
      clean(body);
      assert.equal(body.existing.merchantKey, `manual:${T_REC}`);
      assert.equal(body.existing.kind, 'attach');
      assert.equal(body.existing.strength, 'exact');
      assert.equal(body.existing.name, 'Netflix');
      assert.equal(body.needsCategory, false);
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: a cancelled subscription offers attach before, final-or-back after the cancellation`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ cancelled_at: '2026-10-10T12:00:00Z' })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-09-03', amount: 10.99, description: 'Netflix' }),
        await txRow({ n: 3, date: '2026-11-03', amount: 10.99, description: 'Netflix' }),
      ],
    });
    const { http } = await boot(t);
    try {
      assert.equal((await http.get(`/track/preview?transactionId=${id(2)}`)).body.existing.kind, 'attach');
      assert.equal((await http.get(`/track/preview?transactionId=${id(3)}`)).body.existing.kind, 'finalOrBack');
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: "detected" is the exact note only — a detected "Apple TV" never blocks "Apple Music"`, async () => {
    const t = await tables({
      transactions: [
        ...(await monthly(10, 'Apple TV', 8.99)),
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Apple Music' }),
        await txRow({ n: 2, date: '2026-10-04', amount: 8.99, description: 'Apple TV' }),
      ],
    });
    const { http } = await boot(t);
    try {
      assert.equal((await http.get(`/track/preview?transactionId=${id(1)}`)).body.detected, null);
      const tv = await http.get(`/track/preview?transactionId=${id(2)}`);
      assert.equal(tv.body.detected.merchantKey, 'apple tv');
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: likely = same note a cycle apart; maybe = other look-alikes; needsCategory reported`, async () => {
    const t = await tables({
      transactions: [
        // "Crunchyroll", not "Netflix": the seed's ACTIVE Repeat-this owns "Netflix",
        // and charges it owns are never offered as candidates.
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Crunchyroll' }),
        await txRow({ n: 2, date: '2026-09-03', amount: 10.99, description: 'Crunchyroll' }),
        await txRow({ n: 3, date: '2026-09-20', amount: 10.99, description: 'Crunchyroll' }), // mid-cycle
        await txRow({ n: 4, date: '2026-08-15', amount: 10.5 }), // no note, same category
        // Its own note, so it only exercises needsCategory (an exact "Crunchyroll" note
        // would rightly appear under maybe — names match regardless of category).
        await txRow({ n: 5, date: '2026-10-05', amount: 30, description: 'Gym', cat: null }),
      ],
    });
    const { http } = await boot(t);
    try {
      const { body } = await http.get(`/track/preview?transactionId=${id(1)}&interval=monthly`);
      assert.deepEqual(body.likely.map((c) => c.id), [id(2)]);
      assert.deepEqual(body.maybe.map((c) => c.id).sort(), [id(3), id(4)].sort());
      const noCat = await http.get(`/track/preview?transactionId=${id(5)}`);
      assert.equal(noCat.body.needsCategory, true);
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: 404 for another user's transaction, 400 for income`, async () => {
    const t = await tables({
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 5, description: 'Theirs', user: U2 }),
        await txRow({ n: 2, date: '2026-10-03', amount: 5, description: 'Salary', type: 'income' }),
      ],
    });
    const { http } = await boot(t);
    try {
      assert.equal((await http.get(`/track/preview?transactionId=${id(1)}`)).status, 404);
      assert.equal((await http.get(`/track/preview?transactionId=${id(2)}`)).status, 400);
    } finally {
      await http.close();
    }
  });

  // --- recent ---------------------------------------------------------------------

  test(`${label} recent: an old yearly charge is found by search even behind 200+ newer expenses`, async () => {
    // Dates relative to today: the endpoint looks back 13 months from NOW, so fixed
    // dates would start failing once they aged out of that window.
    const DAY = 86400000;
    const ago = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
    const rows = [await txRow({ n: 1, date: ago(270), amount: 95, description: 'Amazon Prime' })];
    for (let i = 0; i < 205; i += 1) {
      const d = ago(150 - i * 0.5);
      rows.push(await txRow({ n: 1000 + i, date: d, amount: 3, description: 'Coffee' }));
    }
    const { http } = await boot(await tables({ transactions: rows }), { maxRows: 120 });
    try {
      const all = await http.get('/track/recent');
      assert.equal(all.body.transactions.length, 200, 'newest 200 only');
      const { body } = await http.get('/track/recent?q=amazon');
      assert.deepEqual(body.transactions.map((x) => x.id), [id(1)]);
      clean(body);
    } finally {
      await http.close();
    }
  });

  // --- track ----------------------------------------------------------------------

  test(`${label} track: marks a subscription, links chosen charges, stores the right columns`, async () => {
    const t = await tables({
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Crunchyroll' }),
        await txRow({ n: 2, date: '2026-09-03', amount: 10.99, description: 'Crunchyroll' }),
        await txRow({ n: 3, date: '2026-09-03', amount: 50, description: 'Theirs', user: U2 }),
        await txRow({ n: 4, date: '2026-09-03', amount: 50, description: 'Salary', type: 'income' }),
        await txRow({ n: 5, date: '2026-08-03', amount: 10.99, description: 'Netflix', rec: REC }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      const { status, body } = await http.send('POST', '/track', {
        transactionId: id(1), interval: 'monthly', includeTransactionIds: [id(2), id(3), id(4), id(5)],
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.subscription.linkedCount, 2, 'only this user\'s unlinked expenses are linked');
      const recId = body.subscription.merchantKey.slice('manual:'.length);
      const stored = db.store.recurrences.find((r) => r.id === recId);
      assert.equal(stored.auto_log, false);
      assert.equal(stored.next_run_at, null);
      assert.equal(stored.interval, 'monthly');
      if (phase === 'off') assert.equal(stored.description, 'Crunchyroll');
      else {
        const { decryptRegistered } = await import('../../lib/crypto.js');
        assert.equal(decryptRegistered('recurrences.description', U, stored.description_enc), 'Crunchyroll');
        if (phase === 'enc') assert.equal(stored.description, undefined);
      }
      assert.equal(db.store.transactions.find((r) => r.id === id(3)).recurrence_id, null, 'other user untouched');
      assert.equal(db.store.transactions.find((r) => r.id === id(4)).recurrence_id, null, 'income untouched');
      assert.equal(db.store.transactions.find((r) => r.id === id(5)).recurrence_id, REC, 'already linked untouched');
      assert.ok(!db.store.transactions.some((r) => r.is_recurring), 'is_recurring keeps meaning Repeat-this');
    } finally {
      await http.close();
    }
  });

  test(`${label} track: an exact note already tracked is a 409 even after a +300% price jump — then attach, and the amount follows`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Disney Plus', amount: 1.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 1.99, description: 'Disney Plus', rec: T_REC }),
        await txRow({ n: 2, date: '2026-11-03', amount: 7.99, description: 'Disney Plus' }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      const before = db.store.recurrences.length;
      const conflict = await http.send('POST', '/track', { transactionId: id(2), interval: 'monthly' });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.existing.merchantKey, `manual:${T_REC}`);
      assert.equal(conflict.body.existing.strength, 'exact');
      assert.equal(db.store.recurrences.length, before, 'no second subscription');
      const att = await http.send('POST', `/manual:${T_REC}/attach`, { transactionId: id(2) });
      assert.equal(att.status, 200, JSON.stringify(att.body));
      assert.equal(sub((await http.get('/')).body, `manual:${T_REC}`).amount, 7.99);
    } finally {
      await http.close();
    }
  });

  test(`${label} track: a note Trim already logs with Repeat-this is a 409 — never a second subscription`, async () => {
    // The seed has an ACTIVE Repeat-this "Netflix" (REC). Marking a hand-added
    // "Netflix" expense would put the same service on the page twice.
    const t = await tables({
      transactions: [await txRow({ n: 1, date: '2026-10-03', amount: 9.99, description: 'Netflix' })],
    });
    const { db, http } = await boot(t);
    try {
      const pv = await http.get(`/track/preview?transactionId=${id(1)}`);
      assert.equal(pv.status, 200, JSON.stringify(pv.body));
      assert.equal(pv.body.repeating?.merchantKey, `manual:${REC}`, 'preview names the Repeat-this schedule');
      clean(pv.body);
      const before = db.store.recurrences.length;
      const res = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly' });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.repeating.merchantKey, `manual:${REC}`);
      assert.equal(db.store.recurrences.length, before, 'no second subscription');
      assert.equal(db.store.transactions.find((r) => r.id === id(1)).recurrence_id, null, 'not attached to Repeat-this');
    } finally {
      await http.close();
    }
  });

  test(`${label} track: a CANCELLED Repeat-this schedule does not block marking the same note`, async () => {
    const t = await tables({
      transactions: [await txRow({ n: 1, date: '2026-10-03', amount: 9.99, description: 'Netflix' })],
    });
    t.recurrences = t.recurrences.map((r) => (r.id === REC ? { ...r, cancelled_at: '2026-09-15T12:00:00Z' } : r));
    const { http } = await boot(t);
    try {
      assert.equal((await http.get(`/track/preview?transactionId=${id(1)}`)).body.repeating, null);
      const res = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    } finally {
      await http.close();
    }
  });

  test(`${label} track: an exact note of a CANCELLED tracked subscription is still a 409 (answer final-or-back instead)`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Disney Plus', amount: 7.99, cancelled_at: '2026-10-10T12:00:00Z' })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 7.99, description: 'Disney Plus', rec: T_REC }),
        await txRow({ n: 2, date: '2026-11-03', amount: 7.99, description: 'Disney Plus' }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      const before = db.store.recurrences.length;
      const res = await http.send('POST', '/track', { transactionId: id(2), interval: 'monthly' });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.existing.merchantKey, `manual:${T_REC}`);
      assert.equal(res.body.existing.kind, 'finalOrBack');
      assert.equal(res.body.existing.cancelled, true, 'the client can label it "(cancelled)"');
      assert.equal(db.store.recurrences.length, before);
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: the cancellation DAY is the user's local day, not UTC`, async () => {
    // 23:30 UTC on 10 Oct is already 11 Oct in Auckland (UTC+13 in October).
    const t = await tables({
      recurrences: [await trackedRec({ cancelled_at: '2026-10-10T23:30:00Z' })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-10-11', amount: 10.99, description: 'Netflix' }),
      ],
    });
    t.user_stats = [{ ...t.user_stats[0], timezone: 'Pacific/Auckland' }];
    const { http } = await boot(t);
    try {
      const { body } = await http.get(`/track/preview?transactionId=${id(2)}`);
      assert.equal(body.existing?.kind, 'attach', 'charged on the (local) cancellation day — not after it');
    } finally {
      await http.close();
    }
  });

  test(`${label} one note, one kind: a weak look-alike is never offered a note Repeat-this owns, and attach refuses it`, async () => {
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    const APPLE = id(901);
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Apple TV', amount: 8.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-09-05', amount: 8.99, description: 'Apple TV', rec: T_REC }),
        await txRow({ n: 2, date: '2026-10-05', amount: 8.99, description: 'Apple' }),
      ],
    });
    t.recurrences.push({
      id: APPLE, user_id: U, category_id: CAT, type: 'expense', interval: 'monthly', auto_log: true,
      next_run_at: '2026-11-05', last_run_at: null, cancelled_at: null, created_at: '2026-08-05T00:00:00Z',
      ...encodeWrite('recurrences', U, { amount: 8.99, description: 'Apple' }, phase),
    });
    const { db, http } = await boot(t);
    try {
      const pv = (await http.get(`/track/preview?transactionId=${id(2)}`)).body;
      assert.equal(pv.existing, null, 'the weak "Apple TV" offer is withheld');
      assert.equal(pv.repeating?.merchantKey, `manual:${APPLE}`);
      const att = await http.send('POST', `/manual:${T_REC}/attach`, { transactionId: id(2) });
      assert.equal(att.status, 409, JSON.stringify(att.body));
      assert.equal(att.body.repeating.merchantKey, `manual:${APPLE}`);
      assert.equal(db.store.transactions.find((r) => r.id === id(2)).recurrence_id, null, 'nothing linked');
    } finally {
      await http.close();
    }
  });

  test(`${label} one note, one kind: an EDITED note on a Repeat-this charge does not own that note`, async () => {
    const t = await tables({
      transactions: [
        await txRow({ n: 1, date: '2026-09-01', amount: 9.99, description: 'Netflix and Spotify', rec: REC }),
        await txRow({ n: 2, date: '2026-10-03', amount: 9.99, description: 'Netflix and Spotify' }),
      ],
    });
    const { http } = await boot(t);
    try {
      assert.equal((await http.get(`/track/preview?transactionId=${id(2)}`)).body.repeating, null);
      const res = await http.send('POST', '/track', { transactionId: id(2), interval: 'monthly' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    } finally {
      await http.close();
    }
  });

  test(`${label} one note, one kind: re-activating either kind beside an active one of the other is refused`, async () => {
    // Seed: ACTIVE Repeat-this "Netflix" (REC). A cancelled tracked "Netflix" may not come back.
    const t = await tables({
      recurrences: [
        await trackedRec({ cancelled_at: '2026-10-10T12:00:00Z' }),
        await trackedRec({ rid: id(902), description: 'Disney Plus', cancelled_at: '2026-10-10T12:00:00Z' }),
      ],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-11-03', amount: 10.99, description: 'Netflix' }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      const back = await http.send('PATCH', `/manual:${T_REC}`, { status: 'active' });
      assert.equal(back.status, 409, JSON.stringify(back.body));
      assert.equal(back.body.repeating.merchantKey, `manual:${REC}`);
      const viaAttach = await http.send('POST', `/manual:${T_REC}/attach`, { transactionId: id(2), reactivate: true });
      assert.equal(viaAttach.status, 409, JSON.stringify(viaAttach.body));
      assert.equal(db.store.transactions.find((r) => r.id === id(2)).recurrence_id, null, 'refused BEFORE linking');
      assert.ok(db.store.recurrences.find((r) => r.id === T_REC).cancelled_at, 'still cancelled');
      // Control: a tracked subscription with no clash comes back fine.
      assert.equal((await http.send('PATCH', `/manual:${id(902)}`, { status: 'active' })).status, 200);
      // The other direction: cancel the Repeat-this, reactivate the tracked one, then the Repeat-this can't return.
      assert.equal((await http.send('PATCH', `/manual:${REC}`, { status: 'cancelled' })).status, 200);
      assert.equal((await http.send('PATCH', `/manual:${T_REC}`, { status: 'active' })).status, 200);
      const rep = await http.send('PATCH', `/manual:${REC}`, { status: 'active' });
      assert.equal(rep.status, 409, JSON.stringify(rep.body));
      assert.equal(rep.body.existing.merchantKey, `manual:${T_REC}`);
      assert.ok(db.store.recurrences.find((r) => r.id === REC).cancelled_at, 'Repeat-this still cancelled');
    } finally {
      await http.close();
    }
  });

  test(`${label} track: a failed race re-check rolls everything back (500, no subscription, nothing linked)`, async () => {
    const t = await tables({
      transactions: [await txRow({ n: 1, date: '2026-10-03', amount: 11.99, description: 'Spotify' })],
    });
    let selects = 0;
    // 1st recurrences select = loadState, 2nd = the race re-check after the insert.
    const { db, http } = await boot(t, { failOn: (table, op) => table === 'recurrences' && op === 'select' && ++selects === 2 });
    try {
      const res = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly' });
      assert.equal(res.status, 500);
      assert.equal(db.store.recurrences.filter((r) => r.auto_log === false).length, 0, 'no tracked subscription left');
      assert.equal(db.store.transactions.find((r) => r.id === id(1)).recurrence_id, null, 'nothing left linked');
    } finally {
      await http.close();
    }
  });

  test(`${label} track/attach: a charge orphaned from a deleted Repeat-this schedule loses its Recurring flag when tracked`, async () => {
    const orphan = { ...(await txRow({ n: 1, date: '2026-10-03', amount: 11.99, description: 'Spotify' })), is_recurring: true };
    const orphan2 = { ...(await txRow({ n: 2, date: '2026-11-03', amount: 11.99, description: 'Spotify' })), is_recurring: true };
    const { db, http } = await boot(await tables({ transactions: [orphan, orphan2] }));
    try {
      const res = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(db.store.transactions.find((r) => r.id === id(1)).is_recurring, false);
      const key = res.body.subscription.merchantKey;
      assert.equal((await http.send('POST', `/${key}/attach`, { transactionId: id(2) })).status, 200);
      assert.equal(db.store.transactions.find((r) => r.id === id(2)).is_recurring, false);
    } finally {
      await http.close();
    }
  });

  test(`${label} one note, one kind: a charge Repeat-this owns is never offered as a candidate, and /track refuses it as an extra`, async () => {
    // Seed: ACTIVE Repeat-this "Netflix" (REC).
    const t = await tables({
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 9.99, description: 'Netflix Premium' }),
        await txRow({ n: 2, date: '2026-09-03', amount: 9.99, description: 'Netflix' }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      const pv = (await http.get(`/track/preview?transactionId=${id(1)}&interval=monthly`)).body;
      const offered = [...pv.likely, ...pv.maybe].map((c) => c.id);
      assert.ok(!offered.includes(id(2)), 'the Repeat-this-owned "Netflix" charge is not offered');
      const before = db.store.recurrences.length;
      const res = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly', includeTransactionIds: [id(2)] });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.repeating.merchantKey, `manual:${REC}`);
      assert.equal(db.store.recurrences.length, before, 'nothing created');
      assert.equal(db.store.transactions.find((r) => r.id === id(2)).recurrence_id, null);
    } finally {
      await http.close();
    }
  });

  test(`${label} one note, one kind: a subscription that merely ABSORBED a Repeat-this note (an edited charge) is not offered it`, async () => {
    // Tracked "Disney Plus" with one attached charge whose note Alex edited to "Netflix";
    // the seed's ACTIVE Repeat-this "Netflix" owns that note.
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Disney Plus', amount: 9.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-09-03', amount: 9.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-10-03', amount: 9.99, description: 'Netflix' }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      const pv = (await http.get(`/track/preview?transactionId=${id(2)}`)).body;
      assert.equal(pv.existing, null, '"Add to Disney Plus" is withheld');
      assert.equal(pv.repeating?.merchantKey, `manual:${REC}`);
      const att = await http.send('POST', `/manual:${T_REC}/attach`, { transactionId: id(2) });
      assert.equal(att.status, 409, JSON.stringify(att.body));
      assert.equal(db.store.transactions.find((r) => r.id === id(2)).recurrence_id, null);
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: "is back" is not offered (canReactivate false) while a Repeat-this schedule logs the note`, async () => {
    const t = await tables({
      recurrences: [
        await trackedRec({ cancelled_at: '2026-09-05T12:00:00Z' }), // "Netflix" — the seed's Repeat-this "Netflix" is active
        await trackedRec({ rid: id(903), description: 'Disney Plus', cancelled_at: '2026-09-05T12:00:00Z' }),
      ],
      transactions: [
        await txRow({ n: 1, date: '2026-09-01', amount: 10.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-09-30', amount: 10.99, description: 'Netflix' }),
        await txRow({ n: 3, date: '2026-09-01', amount: 7.99, description: 'Disney Plus', rec: id(903) }),
        await txRow({ n: 4, date: '2026-09-30', amount: 7.99, description: 'Disney Plus' }),
      ],
    });
    const { http } = await boot(t);
    try {
      const nf = (await http.get(`/track/preview?transactionId=${id(2)}`)).body.existing;
      assert.equal(nf.kind, 'finalOrBack');
      assert.equal(nf.canReactivate, false);
      const dp = (await http.get(`/track/preview?transactionId=${id(4)}`)).body.existing;
      assert.equal(dp.kind, 'finalOrBack');
      assert.equal(dp.canReactivate, true, 'control: no schedule logs "Disney Plus"');
    } finally {
      await http.close();
    }
  });

  test(`${label} track: a weak resemblance never blocks — two different services are both trackable`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Apple Music', amount: 10.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Apple Music', rec: T_REC }),
        await txRow({ n: 2, date: '2026-10-05', amount: 8.99, description: 'Apple TV' }),
        await txRow({ n: 3, date: '2026-10-06', amount: 10.99 }),
      ],
    });
    const { http } = await boot(t);
    try {
      assert.equal((await http.send('POST', '/track', { transactionId: id(2), interval: 'monthly' })).status, 201);
      assert.equal((await http.send('POST', '/track', { transactionId: id(3), interval: 'monthly' })).status, 201);
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: a double submit never leaves a second (orphan) subscription`, async () => {
    const t = await tables({ transactions: [await txRow({ n: 1, date: '2026-10-03', amount: 4.99, description: 'Spotify' })] });
    const { db, http } = await boot(t);
    try {
      const first = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly' });
      assert.equal(first.status, 201);
      const count = db.store.recurrences.length;
      const second = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly' });
      assert.equal(second.status, 409);
      assert.equal(db.store.recurrences.length, count, 'no orphan row');
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: if the link races and misses the marked expense, the new row is rolled back`, async () => {
    const t = await tables({ transactions: [await txRow({ n: 1, date: '2026-10-03', amount: 4.99, description: 'Spotify' })] });
    const { db, http } = await boot(t);
    try {
      // Simulate another request linking it between our checks and our update.
      const origFrom = db.from.bind(db);
      let raced = false;
      db.from = (table) => {
        const q = origFrom(table);
        if (table === 'transactions' && !raced) {
          const origUpdate = q.update.bind(q);
          q.update = (payload) => {
            raced = true;
            db.store.transactions.find((r) => r.id === id(1)).recurrence_id = REC;
            return origUpdate(payload);
          };
        }
        return q;
      };
      const before = db.store.recurrences.length;
      const res = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly' });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(db.store.recurrences.length, before, 'the inserted recurrence was deleted again');
    } finally {
      await http.close();
    }
  });

  test(`${label} track: 400 for income or a missing category, 404 for another user's expense`, async () => {
    const t = await tables({
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 5, description: 'Salary', type: 'income' }),
        await txRow({ n: 2, date: '2026-10-03', amount: 5, description: 'Thing', cat: null }),
        await txRow({ n: 3, date: '2026-10-03', amount: 5, description: 'Theirs', user: U2 }),
      ],
    });
    const { http } = await boot(t);
    try {
      assert.equal((await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly' })).status, 400);
      const noCat = await http.send('POST', '/track', { transactionId: id(2), interval: 'monthly' });
      assert.equal(noCat.status, 400);
      assert.match(noCat.body.error, /category/);
      assert.equal((await http.send('POST', '/track', { transactionId: id(3), interval: 'monthly' })).status, 404);
    } finally {
      await http.close();
    }
  });

  // --- attach / detach / delete ------------------------------------------------------

  test(`${label} attach/detach: ownership, Repeat-this refused, conditional link, reactivate`, async () => {
    const t = await tables({
      // "Disney Plus", not "Netflix": the seed has an ACTIVE Repeat-this "Netflix",
      // and re-activating a tracked "Netflix" beside it is refused (one note, one kind).
      recurrences: [
        await trackedRec({ description: 'Disney Plus', cancelled_at: '2026-10-10T00:00:00Z' }),
        await trackedRec({ rid: id(900), user: U2 }),
      ],
      transactions: [
        await txRow({ n: 1, date: '2026-11-03', amount: 10.99, description: 'Disney Plus' }),
        await txRow({ n: 2, date: '2026-11-04', amount: 10.99, description: 'Netflix', rec: REC }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      assert.equal((await http.send('POST', `/manual:${id(900)}/attach`, { transactionId: id(1) })).status, 404, "another user's subscription");
      assert.equal((await http.send('POST', `/manual:${REC}/attach`, { transactionId: id(1) })).status, 400, 'Repeat-this is not hand-edited');
      assert.equal((await http.send('POST', `/manual:${T_REC}/attach`, { transactionId: id(2) })).status, 409, 'already linked elsewhere');
      const ok = await http.send('POST', `/manual:${T_REC}/attach`, { transactionId: id(1), reactivate: true });
      assert.equal(ok.status, 200);
      assert.equal(db.store.recurrences.find((r) => r.id === T_REC).cancelled_at, null, 'reactivated');
      assert.equal((await http.send('POST', `/manual:${T_REC}/detach`, { transactionId: id(2) })).status, 404, 'not part of this one');
      assert.equal((await http.send('POST', `/manual:${T_REC}/detach`, { transactionId: id(1) })).status, 200);
      assert.equal(db.store.transactions.find((r) => r.id === id(1)).recurrence_id, null);
    } finally {
      await http.close();
    }
  });

  test(`${label} DELETE: removes a tracked subscription, unlinks its charges; Repeat-this is refused`, async () => {
    const t = await tables({
      recurrences: [await trackedRec()],
      transactions: [await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Netflix', rec: T_REC })],
    });
    const { db, http } = await boot(t);
    try {
      assert.equal((await http.send('DELETE', `/manual:${REC}`)).status, 400);
      assert.equal((await http.send('DELETE', `/manual:${T_REC}`)).status, 204);
      assert.ok(!db.store.recurrences.some((r) => r.id === T_REC));
      assert.equal(db.store.transactions[0].recurrence_id, null, 'the charge survives, unlinked');
    } finally {
      await http.close();
    }
  });

  // --- fixes from the final validation pass ----------------------------------------

  test(`${label} GET: a price jump never brings back the old-price row (the subscription's own history)`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Disney Plus', amount: 7.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-05', amount: 7.99, description: 'Disney Plus', rec: T_REC }),
        ...(await monthly(10, 'Disney Plus', 1.99)), // Jul–Sep at the intro price, never attached
      ],
    });
    const { http } = await boot(t);
    try {
      const { body } = await http.get('/');
      assert.equal(autoRows(body).length, 0, 'no stale £1.99 row next to the £7.99 one');
      assert.equal(body.summary.activeMonthly, 7.99 + 9.99, 'Per month = Disney+ at £7.99 + the seeded Repeat-this £9.99');
    } finally {
      await http.close();
    }
  });

  test(`${label} GET: a same-note run that ENDED LONG BEFORE the subscription started stays visible`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ description: 'Disney Plus', amount: 7.99 })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-05', amount: 7.99, description: 'Disney Plus', rec: T_REC }),
        // Jan–Mar at £1.99: seven months before the first attached charge — not the
        // run this subscription continues, so hiding it would be a guess.
        await txRow({ n: 10, date: '2026-01-05', amount: 1.99, description: 'Disney Plus' }),
        await txRow({ n: 11, date: '2026-02-04', amount: 1.99, description: 'Disney Plus' }),
        await txRow({ n: 12, date: '2026-03-06', amount: 1.99, description: 'Disney Plus' }),
      ],
    });
    const { http } = await boot(t);
    try {
      assert.equal(autoRows((await http.get('/')).body).length, 1);
    } finally {
      await http.close();
    }
  });

  test(`${label} GET: a same-note run on a DIFFERENT cadence stays visible`, async () => {
    const t = await tables({
      // A YEARLY plan marked by Alex; the detector finds a MONTHLY run of the same
      // note just before it. (The detector only knows monthly and yearly.)
      recurrences: [await trackedRec({ description: 'Disney Plus', amount: 79.9, interval: 'annual' })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-05', amount: 79.9, description: 'Disney Plus', rec: T_REC }),
        ...(await monthly(10, 'Disney Plus', 7.99)),
      ],
    });
    const { http } = await boot(t);
    try {
      const rows = autoRows((await http.get('/')).body);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].cadence, 'monthly');
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: never points at a detected row the page is hiding (existing wins)`, async () => {
    const t = await tables({
      recurrences: [await trackedRec()],
      transactions: [
        await txRow({ n: 1, date: '2026-06-05', amount: 10.99, description: 'Netflix', rec: T_REC }),
        ...(await monthly(10, 'Netflix', 10.99)), // three missed prompts — suppressed on GET
        await txRow({ n: 2, date: '2026-10-03', amount: 10.99, description: 'Netflix' }),
      ],
    });
    const { http } = await boot(t);
    try {
      const { body } = await http.get(`/track/preview?transactionId=${id(2)}`);
      assert.equal(body.existing?.merchantKey, `manual:${T_REC}`);
      assert.equal(body.detected, null, 'the hidden detected row is not offered');
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: the dialog's typed DATE decides attach vs final-or-back`, async () => {
    const t = await tables({
      recurrences: [await trackedRec({ cancelled_at: '2026-10-10T12:00:00Z' })],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-09-03', amount: 10.99, description: 'Netflix' }),
      ],
    });
    const { http } = await boot(t);
    try {
      const { body } = await http.get(`/track/preview?transactionId=${id(2)}&date=2026-11-03`);
      assert.equal(body.existing.kind, 'finalOrBack');
    } finally {
      await http.close();
    }
  });

  test(`${label} preview: a cycle-aligned £999 purchase with the same note is NOT pre-ticked`, async () => {
    const t = await tables({
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 2.99, description: 'Apple' }),
        await txRow({ n: 2, date: '2026-09-03', amount: 999, description: 'Apple' }),
        await txRow({ n: 3, date: '2026-08-04', amount: 2.99, description: 'Apple' }),
      ],
    });
    const { http } = await boot(t);
    try {
      const { body } = await http.get(`/track/preview?transactionId=${id(1)}&interval=monthly`);
      assert.deepEqual(body.likely.map((c) => c.id), [id(3)]);
      assert.deepEqual(body.maybe.map((c) => c.id), [id(2)], 'offered, but unticked');
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: two marks of DIFFERENT expenses with the same note race — the later one undoes itself`, async () => {
    const t = await tables({
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 4.99, description: 'Spotify' }),
        await txRow({ n: 2, date: '2026-09-03', amount: 4.99, description: 'Spotify' }),
      ],
    });
    const { db, http } = await boot(t);
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    try {
      // While our request inserts, a concurrent one has already created a Spotify row.
      const origFrom = db.from.bind(db);
      let injected = false;
      db.from = (table) => {
        const q = origFrom(table);
        if (table === 'recurrences' && !injected) {
          const origInsert = q.insert.bind(q);
          q.insert = (payload) => {
            injected = true;
            db.store.recurrences.push({
              id: id(777), user_id: U, category_id: CAT, type: 'expense', interval: 'monthly',
              auto_log: false, next_run_at: null, cancelled_at: null, created_at: '2000-01-01T00:00:00Z',
              ...encodeWrite('recurrences', U, { amount: 4.99, description: 'Spotify' }, phase),
            });
            return origInsert({ ...payload, created_at: '2026-10-14T00:00:00Z' });
          };
        }
        return q;
      };
      const res = await http.send('POST', '/track', { transactionId: id(1), interval: 'monthly', includeTransactionIds: [id(2)] });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.existing.merchantKey, `manual:${id(777)}`);
      const tracked = db.store.recurrences.filter((r) => r.auto_log === false);
      assert.deepEqual(tracked.map((r) => r.id), [id(777)], 'our duplicate was deleted');
      assert.ok(db.store.transactions.every((r) => r.recurrence_id == null), 'and every charge it linked was unlinked first');
    } finally {
      await http.close();
    }
  });

  test(`${label} attach and detach touch ONLY the one expense named`, async () => {
    const t = await tables({
      recurrences: [await trackedRec()],
      transactions: [
        await txRow({ n: 1, date: '2026-10-03', amount: 10.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 2, date: '2026-11-03', amount: 10.99, description: 'Netflix', rec: T_REC }),
        await txRow({ n: 3, date: '2026-12-03', amount: 10.99, description: 'Netflix' }),
        await txRow({ n: 4, date: '2026-12-04', amount: 55, description: 'Groceries' }),
      ],
    });
    const { db, http } = await boot(t);
    try {
      await http.send('POST', `/manual:${T_REC}/attach`, { transactionId: id(3) });
      assert.equal(db.store.transactions.find((r) => r.id === id(4)).recurrence_id, null, 'an unrelated expense is untouched');
      await http.send('POST', `/manual:${T_REC}/detach`, { transactionId: id(2) });
      assert.equal(db.store.transactions.find((r) => r.id === id(1)).recurrence_id, T_REC, 'the other charge stays linked');
      assert.equal(db.store.transactions.find((r) => r.id === id(3)).recurrence_id, T_REC);
    } finally {
      await http.close();
    }
  });
}
