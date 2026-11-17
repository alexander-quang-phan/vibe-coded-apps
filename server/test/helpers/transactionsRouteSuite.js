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
  // POST /parse calls the model. Stand in for it and record what the route
  // handed over, which is the thing under test.
  const parseCalls = [];
  const fakeParse = async (args) => {
    parseCalls.push(args);
    return {
      ok: true,
      data: {
        amount: 1200, currency: 'GBP', categoryId: CAT, description: 'tesco', occurredAt: '2026-08-05', confidence: 'high',
      },
    };
  };

  async function boot(tables, opts) {
    const { fakeSupabase, serve } = await import('./routeHarness.js');
    currentDb = fakeSupabase(tables ?? (await seed(phase)), opts);
    if (!mocked) {
      mock.module('../../lib/supabase.js', { exports: { supabase: supabaseProxy } });
      mock.module('../../lib/parser.js', { exports: { parseTransactionText: fakeParse } });
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

  test(`${label} POST /parse hands the parser decoded category names and nothing else`, async () => {
    // The parser writes every category's name into the prompt sent to the model.
    // This read used to be a raw `.select('id, name, type')`: fine while the
    // plaintext column exists, but once migration 019 drops categories.name the
    // real PostgREST rejects the query and every parse fails — and a lenient read
    // would hand the model a null for every name. Exact shape, so no ciphertext
    // or user id can reach the prompt either.
    const { http } = await boot();
    try {
      parseCalls.length = 0;
      const { status, body } = await http.send('POST', '/parse', { text: '12 quid at tesco' });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.parsed.categoryId, CAT);
      assert.equal(parseCalls.length, 1);
      assert.deepEqual(parseCalls[0].categories, [{ id: CAT, name: 'Groceries', type: 'expense' }]);
      assert.equal(parseCalls[0].currency, 'GBP');
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
      assert.equal(rec.auto_log, true, 'Repeat-this writes auto_log explicitly (Phase 17)');
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

  test(`${label} a huge fxRate cannot smuggle an amount past the MAX_AMOUNT cap`, async () => {
    // The schema caps `amount` and `originalAmount` at 1e9 but leaves `fxRate` only
    // positive+finite, so the DERIVED amount (original x rate) reached ~1000x the cap
    // and numeric(14,2) accepted it. One such row skewed every figure on the account.
    const { db, http } = await boot();
    const before = db.store.transactions.length;
    try {
      const { status, body } = await http.send('POST', '/', {
        categoryId: CAT, amount: 1, type: 'expense',
        foreign: { originalAmount: 1_000_000_000, originalCurrency: 'EUR', fxRate: 100 },
      });
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(db.store.transactions.length, before, 'nothing may be stored');
    } finally {
      await http.close();
    }
  });

  test(`${label} PATCH cannot smuggle an over-cap amount either`, async () => {
    const { db, http } = await boot();
    try {
      const { status } = await http.send('PATCH', `/${TX_ID}`, {
        foreign: { originalAmount: 1_000_000_000, originalCurrency: 'EUR', fxRate: 100 },
      });
      assert.equal(status, 400);
      const row = db.store.transactions.find((t) => t.id === TX_ID);
      assert.notEqual(row.amount, 100_000_000_000);
    } finally {
      await http.close();
    }
  });

  test(`${label} a sub-minor-unit conversion is still refused`, async () => {
    // The lower bound must survive the refactor that added the upper one.
    const { http } = await boot();
    try {
      const { status } = await http.send('POST', '/', {
        categoryId: CAT, amount: 1, type: 'expense',
        foreign: { originalAmount: 1, originalCurrency: 'EUR', fxRate: 0.000001 },
      });
      assert.equal(status, 400);
    } finally {
      await http.close();
    }
  });

  test(`${label} PATCH type alone cannot contradict the row's category`, async () => {
    // The seeded row is an expense under an expense category. Sending `type` WITHOUT
    // `categoryId` used to skip the check entirely — it sat inside `if (categoryId)`
    // and was additionally gated on `type` — leaving an income row filed under an
    // expense category, which every aggregate then labelled inconsistently.
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('PATCH', `/${TX_ID}`, { type: 'income' });
      assert.equal(status, 400, JSON.stringify(body));
      const row = db.store.transactions.find((t) => t.id === TX_ID);
      assert.equal(row.type, 'expense', 'the row must be untouched');
    } finally {
      await http.close();
    }
  });

  test(`${label} PATCH: changing expense↔income drops the subscription link; keeping the type keeps it`, async () => {
    // Phase 17: an income row kept its recurrence_id, so it wore a "Subscription"
    // pill nothing could remove and fed Quick Add's matcher.
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    const INC = '44444444-4444-4444-8444-444444444444';
    const REC = '55555555-5555-4555-8555-555555555555';
    const t = await seed(phase);
    t.transactions[0].recurrence_id = REC;
    t.categories.push({
      id: INC, user_id: U, icon: '💼', color: '#22c55e', type: 'income',
      ...encodeWrite('categories', U, { name: 'Salary' }, phase),
    });
    const { db, http } = await boot(t);
    try {
      const same = await http.send('PATCH', `/${TX_ID}`, { type: 'expense', amount: 13 });
      assert.equal(same.status, 200, JSON.stringify(same.body));
      assert.equal(db.store.transactions[0].recurrence_id, REC, 'same type: link kept');
      const flip = await http.send('PATCH', `/${TX_ID}`, { type: 'income', categoryId: INC });
      assert.equal(flip.status, 200, JSON.stringify(flip.body));
      assert.equal(db.store.transactions[0].recurrence_id, null, 'type changed: link dropped');
    } finally {
      await http.close();
    }
  });

  test(`${label} PATCH still accepts a change that keeps type and category agreeing`, async () => {
    // Positive control: the guard above must not block the legitimate edit.
    const { http } = await boot();
    try {
      const { status, body } = await http.send('PATCH', `/${TX_ID}`, {
        categoryId: CAT, type: 'expense', description: 'Tesco Express 9999',
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.transaction.description, 'Tesco Express 9999');
    } finally {
      await http.close();
    }
  });

  // --- Phase 17: "Is this your Netflix subscription?" ---------------------------

  const T_REC = '55555555-5555-4555-8555-555555555555';
  async function withTracked({ cancelled_at = null, extra = [] } = {}) {
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    const base = await seed(phase);
    base.recurrences = [{
      id: T_REC, user_id: U, category_id: CAT, type: 'expense', interval: 'monthly', auto_log: false,
      next_run_at: null, last_run_at: null, cancelled_at, created_at: '2026-08-01T00:00:00Z',
      ...encodeWrite('recurrences', U, { amount: 10.99, description: 'Netflix' }, phase),
    }];
    base.transactions.push({
      id: '44444444-4444-4444-8444-444444444444', user_id: U, category_id: CAT, type: 'expense',
      date: '2026-10-03', is_special: false, special_group_id: null, is_recurring: false,
      recurrence_id: T_REC, original_currency: null, fx_rate: null, created_at: '2026-10-03T09:00:00Z',
      ...encodeWrite('transactions', U, { amount: 10.99, description: 'Netflix', original_amount: null }, phase),
    }, ...extra);
    return base;
  }
  const logNetflix = (http, date, extra = {}) => http.send('POST', '/', {
    categoryId: CAT, amount: 10.99, type: 'expense', description: 'Netflix', date, ...extra,
  });

  test(`${label} create: a charge near the expected date asks about the tracked subscription`, async () => {
    const { http } = await boot(await withTracked());
    try {
      const { status, body } = await logNetflix(http, '2026-11-02');
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.subscriptionMatch.merchantKey, `manual:${T_REC}`);
      assert.equal(body.subscriptionMatch.kind, 'attach');
      assert.equal(body.subscriptionMatch.name, 'Netflix');
      assert.equal(body.subscriptionMatch.category.name, 'Groceries');
      assert.ok(!JSON.stringify(body).includes('_enc'));
    } finally {
      await http.close();
    }
  });

  test(`${label} create: a cancelled subscription asks "is it back?" after the cancellation`, async () => {
    const { http } = await boot(await withTracked({ cancelled_at: '2026-10-10T12:00:00Z' }));
    try {
      const { body } = await logNetflix(http, '2026-12-20');
      assert.equal(body.subscriptionMatch.kind, 'finalOrBack');
    } finally {
      await http.close();
    }
  });

  test(`${label} create: mid-cycle, or with nothing tracked, there is no question`, async () => {
    const tracked = await boot(await withTracked());
    try {
      assert.equal((await logNetflix(tracked.http, '2026-10-18')).body.subscriptionMatch, null);
    } finally {
      await tracked.http.close();
    }
    const plain = await boot();
    try {
      const res = await logNetflix(plain.http, '2026-11-02');
      assert.equal(res.body.subscriptionMatch, null);
      const recReads = plain.db.calls.filter((c) => c.table === 'recurrences' && c.op === 'select');
      assert.equal(recReads.length, 1, 'one cheap existence check, nothing more');
    } finally {
      await plain.http.close();
    }
  });

  test(`${label} create: a failing subscription lookup never fails the create`, async () => {
    const { db, http } = await boot(await withTracked(), { failOn: (t, op) => t === 'recurrences' && op === 'select' });
    try {
      const before = db.store.transactions.length;
      const { status, body } = await logNetflix(http, '2026-11-02');
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.subscriptionMatch, null);
      assert.equal(db.store.transactions.length, before + 1, 'the expense was saved');
    } finally {
      await http.close();
    }
  });

  test(`${label} create: a Repeat-this opt-in is never asked about`, async () => {
    // A CANCELLED tracked Netflix, so the opt-in is allowed (one note, one kind
    // applies to active subscriptions) — and it is still never asked about.
    const { http } = await boot(await withTracked({ cancelled_at: '2026-10-10T12:00:00Z' }));
    try {
      const { status, body } = await logNetflix(http, '2026-11-02', { recurring: { interval: 'monthly' } });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.subscriptionMatch, null);
    } finally {
      await http.close();
    }
  });

  test(`${label} create: "Repeat this" on a note Alex already tracks is refused — nothing is written`, async () => {
    const { db, http } = await boot(await withTracked());
    try {
      const recs = db.store.recurrences.length;
      const txs = db.store.transactions.length;
      const { status, body } = await logNetflix(http, '2026-11-02', { recurring: { interval: 'monthly' } });
      assert.equal(status, 409, JSON.stringify(body));
      assert.equal(body.existing.merchantKey, `manual:${T_REC}`);
      assert.equal(body.existing.name, 'Netflix');
      assert.match(body.error, /Edit dialog/, 'points at the path that always works, not a toast that may not come');
      assert.equal(db.store.recurrences.length, recs, 'no Repeat-this schedule');
      assert.equal(db.store.transactions.length, txs, 'no transaction');
      assert.ok(!JSON.stringify(body).includes('_enc'));
    } finally {
      await http.close();
    }
  });

  test(`${label} create: after a cancellation, "It's back" is not offered while a Repeat-this schedule logs the note`, async () => {
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    const t = await withTracked({ cancelled_at: '2026-10-10T12:00:00Z' });
    t.recurrences.push({
      id: '66666666-6666-4666-8666-666666666666', user_id: U, category_id: CAT, type: 'expense',
      interval: 'monthly', auto_log: true, next_run_at: '2026-12-01', last_run_at: null, cancelled_at: null,
      created_at: '2026-10-12T00:00:00Z',
      ...encodeWrite('recurrences', U, { amount: 10.99, description: 'Netflix' }, phase),
    });
    const { http } = await boot(t);
    try {
      const { body } = await logNetflix(http, '2026-12-20');
      assert.equal(body.subscriptionMatch?.kind, 'finalOrBack');
      assert.equal(body.subscriptionMatch.canReactivate, false);
    } finally {
      await http.close();
    }
    const { http: http2 } = await boot(await withTracked({ cancelled_at: '2026-10-10T12:00:00Z' }));
    try {
      const { body } = await logNetflix(http2, '2026-12-20');
      assert.equal(body.subscriptionMatch?.canReactivate, true, 'control: nothing logs it');
    } finally {
      await http2.close();
    }
  });

  test(`${label} create: a note a Repeat-this schedule owns is never offered to a weak look-alike`, async () => {
    // Tracked "Netflix" (first word "netflix") + an active Repeat-this "Netflix Kids":
    // a hand-logged "Netflix Kids" would be a first-word ask — but that note is the
    // schedule's own, so Quick Add must not ask to add it to "Netflix".
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    const t = await withTracked();
    t.recurrences.push({
      id: '66666666-6666-4666-8666-666666666666', user_id: U, category_id: CAT, type: 'expense',
      interval: 'monthly', auto_log: true, next_run_at: '2026-12-01', last_run_at: null, cancelled_at: null,
      created_at: '2026-09-01T00:00:00Z',
      ...encodeWrite('recurrences', U, { amount: 10.99, description: 'Netflix Kids' }, phase),
    });
    const { http } = await boot(t);
    try {
      const { body } = await logNetflix(http, '2026-11-02', { description: 'Netflix Kids' });
      assert.equal(body.subscriptionMatch, null);
      // Control: the same look-alike WITHOUT the schedule does ask.
    } finally {
      await http.close();
    }
    const { http: http2 } = await boot(await withTracked());
    try {
      const { body } = await logNetflix(http2, '2026-11-02', { description: 'Netflix Kids' });
      assert.equal(body.subscriptionMatch?.merchantKey, `manual:${T_REC}`, 'control: a weak look-alike is asked about');
    } finally {
      await http2.close();
    }
  });
  // --- Phase 18: trips -------------------------------------------------------------

  const OTHER_USER = '00000000-0000-4000-8000-000000000002';
  const INCOME_CAT = '11111111-1111-4111-8111-111111111112';
  const KEEP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // keep out of monthly: on
  const OPEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'; // keep out of monthly: off
  const KEEP2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
  const THEIRS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  const ROME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'; // KEEP, 12th-15th
  const NAPLES = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'; // KEEP, 16th-19th
  const PARIS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'; // OPEN
  const GROUP = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

  async function tripTables(row = {}) {
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    const t = await seed(phase);
    const trip = (id, user_id, name, keep) => ({
      id, user_id, start_date: '2026-10-12', end_date: '2026-10-19', keep_out_of_monthly: keep,
      archived_at: null, source_group_id: null, created_at: '2026-10-01T10:00:00Z',
      ...encodeWrite('trips', user_id, { name, total_budget: 1000 }, phase),
    });
    const stop = (id, trip_id, name, start_date, end_date) => ({
      id, user_id: U, trip_id, start_date, end_date, currency: null, created_at: '2026-10-01T10:00:00Z',
      ...encodeWrite('trip_stops', U, { name, budget: null }, phase),
    });
    t.trips = [
      trip(KEEP, U, 'Italy', true),
      trip(OPEN, U, 'Paris', false),
      trip(KEEP2, U, 'Spain', true),
      trip(THEIRS, OTHER_USER, 'Not yours', true),
    ];
    t.trip_stops = [
      stop(ROME, KEEP, 'Rome', '2026-10-12', '2026-10-15'),
      stop(NAPLES, KEEP, 'Naples', '2026-10-16', '2026-10-19'),
      stop(PARIS, OPEN, 'Paris', '2026-10-12', '2026-10-19'),
    ];
    t.special_groups = [{
      id: GROUP, user_id: U, archived_at: null, created_at: '2026-10-01T10:00:00Z',
      ...encodeWrite('special_groups', U, { name: 'Holiday' }, phase),
    }];
    t.categories.push({
      id: INCOME_CAT, user_id: U, icon: '💼', color: '#22c55e', type: 'income',
      ...encodeWrite('categories', U, { name: 'Salary' }, phase),
    });
    t.transactions[0] = {
      ...t.transactions[0], date: '2026-10-13', trip_id: null, trip_stop_id: null, ...row,
    };
    return t;
  }

  const stored = (db) => db.store.transactions.find((r) => r.id === TX_ID);
  const logged = (db) => db.store.transactions.at(-1);
  const threeTap = { categoryId: CAT, amount: 12, type: 'expense', date: '2026-10-13' };

  /** Boot on the trip tables, hand the test its db and http, always close. */
  async function onTrips(row, fn) {
    const { db, http } = await boot(await tripTables(row));
    try {
      await fn(db, http);
    } finally {
      await http.close();
    }
  }

  test(`${label} CRITICAL: a 3-tap POST with a keep-out trip and no isSpecial is stored starred`, async () => {
    // The red team's blocker: Quick Add always sent isSpecial:false, so every trip
    // expense would have counted in the monthly budget.
    await onTrips({}, async (db, http) => {
      const { status, body } = await http.send('POST', '/', { ...threeTap, tripId: KEEP });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(logged(db).trip_id, KEEP, 'the validated field is also written (2026-08-08)');
      assert.equal(logged(db).is_special, true);
      assert.equal(body.transaction.trip_id, KEEP);
      assert.equal(body.transaction.is_special, true);
    });
  });

  test(`${label} POST: a keep-out-off trip leaves the star off, and an explicit isSpecial wins`, async () => {
    await onTrips({}, async (db, http) => {
      await http.send('POST', '/', { ...threeTap, tripId: OPEN });
      assert.equal(logged(db).trip_id, OPEN);
      assert.equal(logged(db).is_special, false);

      await http.send('POST', '/', { ...threeTap, tripId: KEEP, isSpecial: false });
      assert.equal(logged(db).is_special, false, 'explicit false beats the keep-out trip');

      await http.send('POST', '/', { ...threeTap, tripId: OPEN, isSpecial: true });
      assert.equal(logged(db).is_special, true, 'explicit true on a keep-out-off trip');
    });
  });

  test(`${label} POST: with no trip fields nothing about trips is read or set`, async () => {
    await onTrips({}, async (db, http) => {
      const { status } = await http.send('POST', '/', threeTap);
      assert.equal(status, 201);
      assert.equal(logged(db).trip_id, null);
      assert.equal(logged(db).trip_stop_id, null);
      assert.equal(logged(db).is_special, false);
      assert.equal(db.calls.filter((c) => c.table === 'trips').length, 0, 'ordinary logging costs no extra query');
    });
  });

  test(`${label} POST: another user's trip is a 404, and nothing is written`, async () => {
    await onTrips({}, async (db, http) => {
      const before = db.store.transactions.length;
      const { status } = await http.send('POST', '/', { ...threeTap, tripId: THEIRS });
      assert.equal(status, 404);
      assert.equal(db.store.transactions.length, before);
    });
  });

  test(`${label} POST: income can't be on a trip`, async () => {
    await onTrips({}, async (_db, http) => {
      const { status, body } = await http.send('POST', '/', { ...threeTap, categoryId: INCOME_CAT, type: 'income', tripId: KEEP });
      assert.equal(status, 400);
      assert.match(body.error, /Only expenses/);
    });
  });

  test(`${label} POST: a trip and a group together is a 400, never the database CHECK's 500`, async () => {
    await onTrips({}, async (_db, http) => {
      const { status, body } = await http.send('POST', '/', { ...threeTap, tripId: KEEP, specialGroupId: GROUP, isSpecial: true });
      assert.equal(status, 400);
      assert.match(body.error, /trip or in a special group/);
    });
  });

  test(`${label} POST: "Repeat this" on a trip is refused before a schedule is created`, async () => {
    await onTrips({}, async (db, http) => {
      const { status, body } = await http.send('POST', '/', { ...threeTap, tripId: KEEP, recurring: { interval: 'monthly' } });
      assert.equal(status, 400);
      assert.match(body.error, /subscription or repeating/);
      assert.equal(db.store.recurrences.length, 0);
    });
  });

  test(`${label} POST: a city needs a trip, and must be on that trip`, async () => {
    await onTrips({}, async (_db, http) => {
      const none = await http.send('POST', '/', { ...threeTap, tripStopId: ROME });
      assert.equal(none.status, 400);
      assert.match(none.body.error, /needs a trip/);
      const wrong = await http.send('POST', '/', { ...threeTap, tripId: KEEP, tripStopId: PARIS });
      assert.equal(wrong.status, 400);
      assert.match(wrong.body.error, /not on this trip/);
    });
  });

  test(`${label} POST: the date's own stop is stored as null; a different one is an override`, async () => {
    await onTrips({}, async (db, http) => {
      await http.send('POST', '/', { ...threeTap, tripId: KEEP, tripStopId: ROME });
      assert.equal(logged(db).trip_stop_id, null, 'storing the derived city would freeze it');
      await http.send('POST', '/', { ...threeTap, tripId: KEEP, tripStopId: NAPLES });
      assert.equal(logged(db).trip_stop_id, NAPLES);
    });
  });

  test(`${label} PATCH: joining a keep-out trip stars it, stores the trip and clears a group`, async () => {
    await onTrips({ is_special: true, special_group_id: GROUP }, async (db, http) => {
      const { status, body } = await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(stored(db).trip_id, KEEP);
      assert.equal(stored(db).is_special, true);
      assert.equal(stored(db).special_group_id, null);
      assert.equal(body.transaction.trip_id, KEEP);
    });
    await onTrips({ is_special: false }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP });
      assert.equal(stored(db).is_special, true);
    });
  });

  test(`${label} PATCH: joining a keep-out-off trip keeps the star exactly as it was`, async () => {
    await onTrips({ is_special: true }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: OPEN });
      assert.equal(stored(db).trip_id, OPEN);
      assert.equal(stored(db).is_special, true);
    });
    await onTrips({ is_special: false }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: OPEN });
      assert.equal(stored(db).is_special, false);
    });
  });

  test(`${label} PATCH: leaving a keep-out trip un-stars and drops the override`, async () => {
    await onTrips({ trip_id: KEEP, trip_stop_id: NAPLES, is_special: true }, async (db, http) => {
      const { status } = await http.send('PATCH', `/${TX_ID}`, { tripId: null });
      assert.equal(status, 200);
      assert.equal(stored(db).trip_id, null);
      assert.equal(stored(db).trip_stop_id, null);
      assert.equal(stored(db).is_special, false);
    });
  });

  test(`${label} PATCH: leaving a keep-out-off trip leaves the star alone`, async () => {
    await onTrips({ trip_id: OPEN, is_special: true }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: null });
      assert.equal(stored(db).trip_id, null);
      assert.equal(stored(db).is_special, true);
    });
  });

  test(`${label} PATCH: moving from a keep-out trip to a keep-out-off one un-stars; keep-out to keep-out stays starred`, async () => {
    await onTrips({ trip_id: KEEP, is_special: true }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: OPEN });
      assert.equal(stored(db).trip_id, OPEN);
      assert.equal(stored(db).is_special, false);
    });
    await onTrips({ trip_id: KEEP, is_special: true }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP2 });
      assert.equal(stored(db).is_special, true);
    });
  });

  test(`${label} CRITICAL: re-sending the same trip never touches a hand-set star or the override`, async () => {
    await onTrips({ trip_id: KEEP, trip_stop_id: NAPLES, is_special: false }, async (db, http) => {
      const { status } = await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP, description: 'typo fixed' });
      assert.equal(status, 200);
      assert.equal(stored(db).is_special, false, 'a hand-un-starred trip expense stays un-starred');
      assert.equal(stored(db).trip_stop_id, NAPLES);
    });
  });

  test(`${label} PATCH: an edit with no trip fields leaves the trip, stop and star alone, with no trip query`, async () => {
    await onTrips({ trip_id: KEEP, trip_stop_id: NAPLES, is_special: false }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { description: 'typo fixed', date: '2026-10-14' });
      assert.equal(stored(db).trip_id, KEEP);
      assert.equal(stored(db).trip_stop_id, NAPLES);
      assert.equal(stored(db).is_special, false);
      assert.equal(db.calls.filter((c) => c.table === 'trips').length, 0);
    });
  });

  test(`${label} PATCH: an explicit isSpecial always wins over the derived star`, async () => {
    await onTrips({ trip_id: KEEP, is_special: true }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: null, isSpecial: true });
      assert.equal(stored(db).trip_id, null);
      assert.equal(stored(db).is_special, true);
    });
    await onTrips({ is_special: false }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP, isSpecial: false });
      assert.equal(stored(db).trip_id, KEEP);
      assert.equal(stored(db).is_special, false);
    });
  });

  test(`${label} PATCH: the row star un-stars and the expense stays on its trip`, async () => {
    await onTrips({ trip_id: KEEP, is_special: true }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { isSpecial: false });
      assert.equal(stored(db).trip_id, KEEP);
      assert.equal(stored(db).is_special, false);
    });
  });

  test(`${label} PATCH: a group onto a trip row, or both together, is a 400`, async () => {
    await onTrips({ trip_id: KEEP, is_special: true }, async (db, http) => {
      const onto = await http.send('PATCH', `/${TX_ID}`, { specialGroupId: GROUP });
      assert.equal(onto.status, 400);
      assert.match(onto.body.error, /trip or in a special group/);
      assert.equal(stored(db).special_group_id ?? null, null);
    });
    await onTrips({ is_special: true }, async (_db, http) => {
      const both = await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP, specialGroupId: GROUP });
      assert.equal(both.status, 400);
    });
  });

  test(`${label} PATCH: leaving a keep-out trip for a group needs an explicit star`, async () => {
    await onTrips({ trip_id: KEEP, is_special: true }, async (db, http) => {
      const unstarred = await http.send('PATCH', `/${TX_ID}`, { tripId: null, specialGroupId: GROUP });
      assert.equal(unstarred.status, 400, 'never an unstarred grouped row');
      assert.equal(stored(db).trip_id, KEEP, 'nothing was written');

      const starred = await http.send('PATCH', `/${TX_ID}`, { tripId: null, specialGroupId: GROUP, isSpecial: true });
      assert.equal(starred.status, 200);
      assert.equal(stored(db).trip_id, null);
      assert.equal(stored(db).special_group_id, GROUP);
      assert.equal(stored(db).is_special, true);
    });
  });

  test(`${label} PATCH: changing a trip row to income is refused unless it leaves the trip too`, async () => {
    await onTrips({ trip_id: KEEP, is_special: true }, async (db, http) => {
      const refused = await http.send('PATCH', `/${TX_ID}`, { type: 'income', categoryId: INCOME_CAT });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /Only expenses/);
      assert.equal(stored(db).type, 'expense');

      const left = await http.send('PATCH', `/${TX_ID}`, { type: 'income', categoryId: INCOME_CAT, tripId: null });
      assert.equal(left.status, 200, JSON.stringify(left.body));
      assert.equal(stored(db).trip_id, null);
      assert.equal(stored(db).is_special, false);
    });
  });

  test(`${label} PATCH: a subscription-linked charge can't join a trip, but can still be edited`, async () => {
    const REC = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
    await onTrips({ recurrence_id: REC }, async (db, http) => {
      const refused = await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /subscription or repeating/);
      assert.equal(stored(db).trip_id, null);

      const edited = await http.send('PATCH', `/${TX_ID}`, { description: 'Netflix' });
      assert.equal(edited.status, 200);
    });
  });

  test(`${label} PATCH: another user's trip is a 404 and leaves the row alone`, async () => {
    await onTrips({ trip_id: KEEP, is_special: true }, async (db, http) => {
      const { status } = await http.send('PATCH', `/${TX_ID}`, { tripId: THEIRS });
      assert.equal(status, 404);
      assert.equal(stored(db).trip_id, KEEP);
      assert.equal(stored(db).is_special, true);
    });
  });

  test(`${label} PATCH: changing trip clears the override, unless a stop of the new trip is sent`, async () => {
    await onTrips({ trip_id: KEEP, trip_stop_id: NAPLES, is_special: true }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripId: OPEN });
      assert.equal(stored(db).trip_stop_id, null);
    });
    await onTrips({ trip_id: KEEP, is_special: true }, async (_db, http) => {
      const { status, body } = await http.send('PATCH', `/${TX_ID}`, { tripStopId: PARIS });
      assert.equal(status, 400, 'a stop from another trip');
      assert.match(body.error, /not on this trip/);
    });
    await onTrips({ date: '2026-10-13' }, async (db, http) => {
      const { status } = await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP, tripStopId: NAPLES });
      assert.equal(status, 200);
      assert.equal(stored(db).trip_stop_id, NAPLES);
    });
  });

  test(`${label} PATCH: the override is normalised against the RESULTING date`, async () => {
    await onTrips({ trip_id: KEEP, is_special: true, date: '2026-10-13' }, async (db, http) => {
      // Naples is not the 13th's stop, but it IS the 17th's, so this is just the derived city.
      await http.send('PATCH', `/${TX_ID}`, { date: '2026-10-17', tripStopId: NAPLES });
      assert.equal(stored(db).trip_stop_id, null);
    });
    await onTrips({ trip_id: KEEP, trip_stop_id: NAPLES, is_special: true }, async (db, http) => {
      await http.send('PATCH', `/${TX_ID}`, { tripStopId: null });
      assert.equal(stored(db).trip_stop_id, null, 'null goes back to deriving from the date');
    });
  });

  test(`${label} GET / carries the trip fields and still leaks nothing`, async () => {
    await onTrips({ trip_id: KEEP, trip_stop_id: NAPLES, is_special: true }, async (_db, http) => {
      const { body } = await http.get('/');
      const row = body.transactions.find((t) => t.id === TX_ID);
      assert.equal(row.trip_id, KEEP);
      assert.equal(row.trip_stop_id, NAPLES);
      assert.ok(!JSON.stringify(body).includes('_enc'));
    });
  });

  test(`${label} CRITICAL: another user's transaction can't be edited, put on a trip, or deleted`, async () => {
    const { encodeWrite } = await import('../../lib/encryptionCodec.js');
    const THEIR_TX = '33333333-3333-4333-8333-333333333399';
    const tables = await tripTables();
    tables.transactions.push({
      id: THEIR_TX, user_id: OTHER_USER, category_id: CAT, type: 'expense', date: '2026-10-13',
      is_special: false, special_group_id: null, is_recurring: false, recurrence_id: null,
      trip_id: null, trip_stop_id: null, original_currency: null, fx_rate: null, created_at: '2026-10-13T10:00:00Z',
      ...encodeWrite('transactions', OTHER_USER, { amount: 99, description: 'Theirs', original_amount: null }, phase),
    });
    const { db, http } = await boot(tables);
    try {
      const theirs = () => JSON.stringify(db.store.transactions.find((t) => t.id === THEIR_TX));
      const before = theirs();
      assert.equal((await http.send('PATCH', `/${THEIR_TX}`, { tripId: KEEP })).status, 404);
      assert.equal(theirs(), before);
      await http.send('DELETE', `/${THEIR_TX}`);
      assert.equal(theirs(), before, 'still there');

      // ...and writing my own row writes only my row.
      assert.equal((await http.send('PATCH', `/${TX_ID}`, { tripId: KEEP, description: 'Mine' })).status, 200);
      assert.equal(theirs(), before);
      assert.equal((await http.send('DELETE', `/${TX_ID}`)).status, 204);
      assert.equal(theirs(), before);
    } finally {
      await http.close();
    }
  });
}
