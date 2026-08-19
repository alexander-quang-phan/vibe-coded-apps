/**
 * The 03:00 recurrences cron — `lib/runRecurrences.js`.
 *
 * Until now this had no database-level coverage at all: test/recurrences.test.js
 * covers the date maths only. It is the highest-stakes write in the app, because
 * it runs unattended:
 *
 *   - at phase `dual`, a plaintext-only insert here would leave rows the
 *     migration-019 gate refuses, blocking the cutover every night until
 *     somebody noticed;
 *   - at phase `enc`, `description` no longer exists as a column, so an
 *     un-swept insert would fail on every run.
 *
 * It is also the reason SECURITY.md tells you to disable this cron for the whole
 * cutover window.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const CAT = '11111111-1111-4111-8111-111111111111';
const REC = '88888888-8888-4888-8888-888888888888';
const REC2 = '99999999-9999-4999-8999-999999999999';

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

async function seed(phase) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  return {
    recurrences: [
      {
        id: REC, user_id: U, category_id: CAT, type: 'expense', interval: 'monthly',
        next_run_at: yesterday(), last_run_at: null, cancelled_at: null,
        created_at: '2026-07-05T00:00:00Z',
        ...encodeWrite('recurrences', U, { amount: 9.99, description: 'Netflix' }, phase),
      },
      // A SECOND user, so the per-row key derivation is exercised: one shared
      // key would decrypt both, and a wrong one would decrypt neither.
      {
        id: REC2, user_id: U2, category_id: CAT, type: 'expense', interval: 'monthly',
        next_run_at: yesterday(), last_run_at: null, cancelled_at: null,
        created_at: '2026-07-05T00:00:00Z',
        ...encodeWrite('recurrences', U2, { amount: 42.5, description: 'PureGym' }, phase),
      },
    ],
    transactions: [],
    user_stats: [
      { user_id: U, currency: 'GBP', xp_points: 100, current_streak: 3, last_logged_date: '2026-08-01' },
      { user_id: U2, currency: 'GBP', xp_points: 50, current_streak: 1, last_logged_date: '2026-08-01' },
    ],
  };
}

export function runCronRecurrencesSuite(phase) {
  const label = `[phase=${phase}]`;

  let currentDb = null;
  let mocked = false;
  const supabaseProxy = {
    from: (t) => currentDb.from(t),
    rpc: (...args) => currentDb.rpc(...args),
  };

  async function boot(tables) {
    const { fakeSupabase } = await import('./routeHarness.js');
    currentDb = fakeSupabase(tables ?? (await seed(phase)));
    if (!mocked) {
      mock.module('../../lib/supabase.js', { exports: { supabase: supabaseProxy } });
      mocked = true;
    }
    const { runRecurrences } = await import('../../lib/runRecurrences.js');
    return { db: currentDb, runRecurrences };
  }

  test(`${label} a due recurrence creates a transaction`, async () => {
    const { db, runRecurrences } = await boot();
    const result = await runRecurrences();
    assert.equal(result.errors, 0, JSON.stringify(result));
    assert.equal(result.created, 2, 'both users’ schedules run');
    assert.equal(db.store.transactions.length, 2);
  });

  test(`${label} CRITICAL: the created transaction carries the right columns`, async () => {
    const { db, runRecurrences } = await boot();
    await runRecurrences();
    const tx = db.store.transactions.find((t) => t.recurrence_id === REC);
    assert.ok(tx, 'the transaction must be linked back to its schedule');
    assert.equal(tx.user_id, U);
    assert.equal(tx.is_recurring, true);
    assert.equal(tx.date, today());

    if (phase === 'off') {
      assert.equal(tx.amount, 9.99);
      assert.equal(tx.description, 'Netflix');
      assert.equal(tx.amount_enc, undefined, 'off writes no ciphertext');
    } else {
      const { decryptRegistered } = await import('../../lib/crypto.js');
      // This is the assertion that matters: a row written WITHOUT these is
      // exactly what makes the gate refuse the cutover.
      assert.match(String(tx.amount_enc), /^v2:/, 'the cron must write the ciphertext');
      assert.equal(decryptRegistered('transactions.amount', U, tx.amount_enc), 9.99);
      assert.equal(decryptRegistered('transactions.description', U, tx.description_enc), 'Netflix');
      if (phase === 'enc') {
        assert.equal(tx.description, undefined, 'the dropped column must not be written');
        assert.equal(tx.amount, undefined);
      } else {
        assert.equal(tx.amount, 9.99, 'dual keeps the plaintext too');
      }
    }
  });

  test(`${label} CRITICAL: the merchant blind index is written by the cron too`, async () => {
    // Without it, every subscription created by the nightly sweep is invisible to
    // merchant memory — and after 019 the plaintext is gone, so it can never be
    // recomputed.
    const { db, runRecurrences } = await boot();
    await runRecurrences();
    const tx = db.store.transactions.find((t) => t.recurrence_id === REC);
    if (phase === 'off') {
      assert.equal(tx.merchant_prefix_hmacs, undefined);
      return;
    }
    const { blindIndexMany } = await import('../../lib/crypto.js');
    const { merchantPrefixes } = await import('../../lib/merchant.js');
    assert.deepEqual(
      tx.merchant_prefix_hmacs,
      blindIndexMany('transactions.merchant_prefix_hmacs', U, merchantPrefixes('Netflix')),
    );
  });

  test(`${label} each row is decrypted under ITS OWN user's key`, async () => {
    // The sweep runs across every user at once. A single shared key, or the
    // wrong user's, would corrupt one of these silently.
    const { db, runRecurrences } = await boot();
    await runRecurrences();
    const a = db.store.transactions.find((t) => t.recurrence_id === REC);
    const b = db.store.transactions.find((t) => t.recurrence_id === REC2);
    assert.ok(a && b, 'both users get a transaction');

    if (phase === 'off') {
      assert.equal(a.amount, 9.99);
      assert.equal(b.amount, 42.5);
    } else {
      const { decryptRegistered } = await import('../../lib/crypto.js');
      assert.equal(decryptRegistered('transactions.amount', U, a.amount_enc), 9.99);
      assert.equal(decryptRegistered('transactions.amount', U2, b.amount_enc), 42.5);
      assert.equal(decryptRegistered('transactions.description', U2, b.description_enc), 'PureGym');
      // ...and the other user's key must NOT read it.
      assert.throws(() => decryptRegistered('transactions.amount', U2, a.amount_enc));
    }
  });

  test(`${label} the schedule is advanced and stamped`, async () => {
    const { db, runRecurrences } = await boot();
    await runRecurrences();
    const rec = db.store.recurrences.find((r) => r.id === REC);
    assert.equal(rec.last_run_at, today());
    assert.ok(rec.next_run_at > today(), 'the next run must move into the future');
  });

  test(`${label} cron rows award NO xp and do not touch the streak`, async () => {
    // Alex's decision, 2026-07-18: the streak measures the daily habit of
    // logging by hand. Auto-created rent at 3am must not extend it.
    const { db, runRecurrences } = await boot();
    await runRecurrences();
    const stats = db.store.user_stats.find((s) => s.user_id === U);
    assert.equal(stats.xp_points, 100, 'unchanged');
    assert.equal(stats.current_streak, 3, 'unchanged');
    assert.equal(stats.last_logged_date, '2026-08-01', 'unchanged');
  });

  test(`${label} a cancelled or future schedule is not run`, async () => {
    const tables = await seed(phase);
    tables.recurrences[0].cancelled_at = '2026-08-01T00:00:00Z';
    tables.recurrences[1].next_run_at = '2099-01-01';
    const { db, runRecurrences } = await boot(tables);
    const result = await runRecurrences();
    assert.equal(result.created, 0);
    assert.equal(db.store.transactions.length, 0);
  });

  test(`${label} a second run the same day creates nothing more`, async () => {
    // The claim is `next_run_at = <the value we read>`, so a re-run finds the
    // schedule already advanced and skips it.
    const { db, runRecurrences } = await boot();
    await runRecurrences();
    const after = db.store.transactions.length;
    const second = await runRecurrences();
    assert.equal(second.created, 0, 'nothing new on a same-day re-run');
    assert.equal(db.store.transactions.length, after);
  });
}
