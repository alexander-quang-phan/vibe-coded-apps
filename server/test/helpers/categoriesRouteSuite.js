/**
 * The categories route — DELETE with subscriptions in the category (Phase 17).
 *
 * `recurrences.category_id` is ON DELETE CASCADE, and the delete route used to
 * move only transactions. So deleting a category silently deleted every
 * subscription and Repeat-this schedule filed under it — even when the user chose
 * a category to move things to. These tests pin the fix, at every encryption phase.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const U = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const STREAMING = '11111111-1111-4111-8111-111111111111';
const ENTERTAINMENT = '22222222-2222-4222-8222-222222222222';
const SALARY = '33333333-3333-4333-8333-333333333333';
const THEIRS = '44444444-4444-4444-8444-444444444444';
const REC_TRACKED = '55555555-5555-4555-8555-555555555555';
const REC_REPEAT = '66666666-6666-4666-8666-666666666666';
const REC_OTHER_USER = '77777777-7777-4777-8777-777777777777';

async function seed(phase) {
  const { encodeWrite } = await import('../../lib/encryptionCodec.js');
  const cat = (id, user, name, type = 'expense') => ({
    id, user_id: user, icon: '🎬', color: '#f59e0b', type, is_default: false,
    ...encodeWrite('categories', user, { name }, phase),
  });
  const rec = (id, user, auto_log) => ({
    id, user_id: user, category_id: STREAMING, type: 'expense', interval: 'monthly', auto_log,
    next_run_at: auto_log ? '2026-11-01' : null, last_run_at: null, cancelled_at: null,
    created_at: '2026-08-01T00:00:00Z',
    ...encodeWrite('recurrences', user, { amount: 9.99, description: 'Netflix' }, phase),
  });
  return {
    categories: [
      cat(STREAMING, U, 'Streaming'),
      cat(ENTERTAINMENT, U, 'Entertainment'),
      cat(SALARY, U, 'Salary', 'income'),
      cat(THEIRS, U2, 'Their category'),
    ],
    recurrences: [rec(REC_TRACKED, U, false), rec(REC_REPEAT, U, true), rec(REC_OTHER_USER, U2, false)],
    transactions: [],
    user_stats: [{ user_id: U, currency: 'GBP', timezone: 'UTC' }],
  };
}

export function runCategoriesRouteSuite(phase) {
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
    const { default: router } = await import('../../routes/categories.js');
    const http = await serve(router, { userId: U, mountAt: '/api/categories' });
    return { db: currentDb, http };
  }

  test(`${label} CRITICAL: a category holding only subscriptions is NOT deleted without asking`, async () => {
    const { db, http } = await boot();
    try {
      const { status, body } = await http.send('DELETE', `/${STREAMING}`);
      assert.equal(status, 409, JSON.stringify(body));
      assert.equal(body.transactionCount, 0);
      assert.equal(body.subscriptionCount, 2, "only this user's two schedules are counted");
      assert.ok(db.store.categories.some((c) => c.id === STREAMING), 'the category still exists');
      assert.equal(db.store.recurrences.length, 3, 'nothing was deleted');
    } finally {
      await http.close();
    }
  });

  test(`${label} CRITICAL: reassigning ACTUALLY moves the subscriptions, and only this user's`, async () => {
    const { db, http } = await boot();
    try {
      const { status } = await http.send('DELETE', `/${STREAMING}?reassign_to=${ENTERTAINMENT}`);
      assert.equal(status, 204);
      const moved = (id) => db.store.recurrences.find((r) => r.id === id).category_id;
      assert.equal(moved(REC_TRACKED), ENTERTAINMENT, 'the tracked subscription moved');
      assert.equal(moved(REC_REPEAT), ENTERTAINMENT, 'the Repeat-this schedule moved');
      assert.equal(moved(REC_OTHER_USER), STREAMING, "another user's row is never touched");
      assert.ok(!db.store.categories.some((c) => c.id === STREAMING));
    } finally {
      await http.close();
    }
  });

  test(`${label} the reassign target is checked even when only subscriptions are moving`, async () => {
    const { db, http } = await boot();
    try {
      assert.equal((await http.send('DELETE', `/${STREAMING}?reassign_to=${THEIRS}`)).status, 404, "another user's category");
      assert.equal((await http.send('DELETE', `/${STREAMING}?reassign_to=${SALARY}`)).status, 400, 'an income category');
      assert.equal((await http.send('DELETE', `/${STREAMING}?reassign_to=${STREAMING}`)).status, 400, 'itself');
      assert.ok(db.store.recurrences.every((r) => r.category_id === STREAMING), 'nothing moved on a refused target');
    } finally {
      await http.close();
    }
  });

  test(`${label} an unused category is deleted straight away`, async () => {
    const { db, http } = await boot();
    try {
      assert.equal((await http.send('DELETE', `/${ENTERTAINMENT}`)).status, 204);
      assert.ok(!db.store.categories.some((c) => c.id === ENTERTAINMENT));
    } finally {
      await http.close();
    }
  });
}
