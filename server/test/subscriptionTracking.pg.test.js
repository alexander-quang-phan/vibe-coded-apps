/**
 * Migration 017a (Phase 17 subscription marking), against a REAL PostgreSQL.
 *
 * Route tests run on a fake with no constraints, so they cannot tell whether
 * 017a actually lets a tracked row be inserted. Every POST /api/subscriptions/track
 * inserts `auto_log = false, next_run_at = null`; if the `drop not null` were missing
 * or garbled, every one of those would fail in production with 23502 while every
 * route test stayed green. BUGS-FIXED 2026-09-23 #4 is the other reason this exists:
 * a migration asserted to replay that did not.
 *
 * Runs the ACTUAL files 014 and 017a. Opt-in, exactly like writeBarrier.pg.test.js:
 *
 *     cd server && npm install --no-save pg embedded-postgres && npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const M014 = readFileSync(new URL('../migrations/014_recurrences.sql', import.meta.url), 'utf8');
const M017A = readFileSync(new URL('../migrations/017a_subscription_tracking.sql', import.meta.url), 'utf8');

const U = '00000000-0000-4000-8000-000000000001';
const CAT = '11111111-1111-4111-8111-111111111111';

let pg = null;
let Client = null;
let connInfo = null;
let skipReason = null;
let admin = null;

async function boot() {
  try {
    ({ Client } = await import('pg'));
  } catch {
    skipReason = "the 'pg' package is not installed";
    return;
  }
  if (process.env.TEST_DATABASE_URL) {
    connInfo = { connectionString: process.env.TEST_DATABASE_URL };
    return;
  }
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
  } catch {
    skipReason = 'no TEST_DATABASE_URL and the embedded-postgres package is not installed';
    return;
  }
  // A different range from writeBarrier.pg.test.js, which may be running in parallel.
  const port = 56500 + (process.pid % 900);
  pg = new EmbeddedPostgres({
    databaseDir: join(tmpdir(), `trim-017a-pg-${process.pid}`),
    user: 'trim', password: 'trim', port, persistent: false,
    onLog: () => {}, onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('trim017a');
  connInfo = { host: 'localhost', port, user: 'trim', password: 'trim', database: 'trim017a' };
}

before(async () => {
  await boot();
  if (skipReason) return;
  admin = new Client(connInfo);
  await admin.connect();
  await admin.query("set lock_timeout = '10s'");

  // What 001 and Supabase provide that 014 references — stubs are enough.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if;
    end $$;`);
  }
  await admin.query('create schema if not exists auth');
  await admin.query('create table if not exists auth.users (id uuid primary key)');
  await admin.query(`create or replace function auth.uid() returns uuid language sql stable
    as $$ select null::uuid $$`);
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_type where typname = 'transaction_type') then
      create type public.transaction_type as enum ('income', 'expense');
    end if;
  end $$;`);
  await admin.query('create table if not exists public.categories (id uuid primary key)');
  await admin.query('create table if not exists public.transactions (id uuid primary key default gen_random_uuid())');
  await admin.query(`insert into auth.users (id) values ('${U}') on conflict do nothing`);
  await admin.query(`insert into public.categories (id) values ('${CAT}') on conflict do nothing`);

  // The real 014, then one row that already exists before 017a runs.
  await admin.query(M014);
  await admin.query(`insert into public.recurrences (user_id, category_id, amount, interval, next_run_at)
    values ('${U}', '${CAT}', 9.99, 'monthly', '2026-11-01')`);
});

after(async () => {
  if (admin) await admin.end().catch(() => {});
  if (pg) await pg.stop().catch(() => {});
});

const guard = (t) => {
  if (!skipReason) return false;
  console.warn(`  SKIPPED — ${skipReason}.\n  To run: cd server && npm install --no-save pg embedded-postgres && npm test`);
  t.skip(skipReason);
  return true;
};

/** Insert a recurrence and return the error code, or null if it was accepted. */
async function tryInsert({ autoLog, nextRunAt, interval = 'monthly' }) {
  try {
    await admin.query('savepoint s');
    await admin.query(
      `insert into public.recurrences (user_id, category_id, amount, interval, next_run_at, auto_log)
       values ($1, $2, 5, $3, $4, $5)`,
      [U, CAT, interval, nextRunAt, autoLog],
    );
    await admin.query('release savepoint s');
    return null;
  } catch (err) {
    await admin.query('rollback to savepoint s').catch(() => {});
    return err.code;
  }
}

test('017a applies, and applies AGAIN without error (replay-safe)', async (t) => {
  if (guard(t)) return;
  await admin.query('begin');
  try {
    await admin.query(M017A);
    await admin.query(M017A);
  } finally {
    await admin.query('commit');
  }
});

test('a row that existed before 017a reads auto_log = true (Repeat-this unchanged)', async (t) => {
  if (guard(t)) return;
  const { rows } = await admin.query('select auto_log from public.recurrences order by created_at limit 1');
  assert.equal(rows[0].auto_log, true);
});

test('CRITICAL: a tracked row (auto_log=false, next_run_at=null) is ACCEPTED — the insert every /track makes', async (t) => {
  if (guard(t)) return;
  await admin.query('begin');
  try {
    assert.equal(await tryInsert({ autoLog: false, nextRunAt: null }), null);
  } finally {
    await admin.query('rollback');
  }
});

test('an auto-logging row without a next_run_at is REJECTED by the check', async (t) => {
  if (guard(t)) return;
  await admin.query('begin');
  try {
    assert.equal(await tryInsert({ autoLog: true, nextRunAt: null }), '23514');
  } finally {
    await admin.query('rollback');
  }
});

test("'annual' is accepted and 'yearly' is rejected", async (t) => {
  if (guard(t)) return;
  await admin.query('begin');
  try {
    assert.equal(await tryInsert({ autoLog: false, nextRunAt: null, interval: 'annual' }), null);
    assert.equal(await tryInsert({ autoLog: false, nextRunAt: null, interval: 'yearly' }), '23514');
  } finally {
    await admin.query('rollback');
  }
});
