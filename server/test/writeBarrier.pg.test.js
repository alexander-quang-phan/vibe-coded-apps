/**
 * The write barrier, tested against a REAL PostgreSQL — because the thing it has
 * to get right is transaction visibility, and no in-memory fake has that.
 *
 * WHY THIS FILE EXISTS  [Codex stage-5 RE-VERIFY #2 findings 1 and 2, 2026-08-18]
 *
 * The first version of `018a_encryption_write_barrier.sql` checked the cutover
 * flag with a plain SELECT. Codex found the Critical hole and it reproduced here
 * on PostgreSQL 18.4 exactly as described:
 *
 *   T1: BEGIN; INSERT a plaintext-only row      -- admitted while engaged = false
 *   T2: UPDATE ... SET engaged = true           -- returned IMMEDIATELY
 *   gate: engaged = true, 0 rows visible, pg_stat unmoved  => WOULD PASS
 *   T1: COMMIT                                  -- COMMIT re-fires no trigger
 *   019: drops the plaintext T1 just committed.
 *
 * The previous regression suite could not have caught this: its fake incremented
 * write counters synchronously, whereas PostgreSQL's cumulative statistics
 * exclude in-progress transactions and are explicitly allowed to lag. The fake
 * modelled a database that cannot exist.
 *
 * These tests run the ACTUAL migration file, not a copy of it.
 *
 * HOW TO RUN
 *   - Nothing to do: `npm test` boots a temporary PostgreSQL automatically via
 *     the `embedded-postgres` devDependency and throws it away afterwards.
 *   - Or point it at your own: TEST_DATABASE_URL=postgres://... npm test
 *   - If neither is available the tests SKIP loudly rather than passing quietly.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIGRATION = readFileSync(new URL('../migrations/018a_encryption_write_barrier.sql', import.meta.url), 'utf8');

/** Tables the migration installs triggers on; stubs are enough for this test. */
const GUARDED = [
  'transactions', 'budgets', 'savings_goals', 'savings_contributions', 'user_stats',
  'ask_messages', 'recurrences', 'special_groups', 'subscription_overrides', 'categories',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pg = null;      // embedded-postgres instance, if we started one
let Client = null;
let connInfo = null;
let skipReason = null;

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

  const port = 55500 + (process.pid % 900);
  const databaseDir = join(tmpdir(), `trim-barrier-pg-${process.pid}`);
  pg = new EmbeddedPostgres({
    databaseDir, user: 'trim', password: 'trim', port, persistent: false,
    // The migration's own output is the subject of the test; the server's
    // startup chatter is not.
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('trimtest');
  connInfo = { host: 'localhost', port, user: 'trim', password: 'trim', database: 'trimtest' };
}

const connect = async () => {
  const c = new Client(connInfo);
  await c.connect();
  return c;
};

/**
 * Run a test body with sessions that are ALWAYS closed, even when an assertion
 * throws. Learned the hard way while proving these tests can fail: a leaked open
 * transaction still holds its row locks, so the next test's cleanup DELETE blocks
 * forever and the whole suite hangs instead of reporting a failure.
 */
async function withSessions(fn) {
  const open = [];
  const session = async () => { const c = await connect(); open.push(c); return c; };
  try {
    return await fn(session);
  } finally {
    for (const c of open) {
      await c.query('rollback').catch(() => {});
      await c.end().catch(() => {});
    }
  }
}

let admin = null;

before(async () => {
  await boot();
  if (skipReason) return;
  admin = await connect();
  // Turn any lock wait into a fast, legible error instead of a hung test run.
  await admin.query("set lock_timeout = '10s'");

  // Supabase ships these roles; a bare PostgreSQL does not, and the migration
  // grants/revokes against them.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if;
    end $$;`);
  }
  for (const t of GUARDED) {
    await admin.query(`create table if not exists public.${t} (id serial primary key, user_id uuid, val text)`);
  }

  // The real migration, verbatim.
  await admin.query(MIGRATION);
});

after(async () => {
  if (admin) await admin.end().catch(() => {});
  if (pg) await pg.stop().catch(() => {});
});

/**
 * A SEPARATE database with the guarded tables but WITHOUT 018a applied.
 *
 * The nine original tests all install 018a in `before`, so every transaction they
 * open already has the flag row in its snapshot — which is exactly why they could
 * not exercise the case Codex found. This gives a transaction somewhere to start
 * BEFORE the barrier exists.
 */
async function databaseWithoutBarrier(name) {
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  const info = { ...connInfo, database: name };
  const owner = new Client(info);
  await owner.connect();
  for (const t of GUARDED) {
    await owner.query(`create table public.${t} (id serial primary key, user_id uuid, val text)`);
  }
  return { owner, info };
}

/** Reset between tests: release first, THEN clean up, or the barrier blocks us. */
async function release() {
  await admin.query('update public.encryption_cutover set engaged = false, engaged_at = null');
  for (const t of GUARDED) await admin.query(`delete from public.${t}`);
}

const guard = () => {
  if (skipReason) {
    // Visible in the run, unlike a silent pass.
    console.warn(`  SKIPPED (no PostgreSQL): ${skipReason}`);
    return true;
  }
  return false;
};

test('the migration applies cleanly to a real PostgreSQL', (t) => {
  if (guard()) return t.skip(skipReason);
  assert.ok(admin, 'the migration ran in `before` without throwing');
});

test('CRITICAL REGRESSION: engaging the barrier DRAINS writers admitted before it', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();

  await withSessions(async (session) => {
    // T1 is admitted while the barrier is down, and stays open.
    const t1 = await session();
    await t1.query('begin');
    await t1.query("insert into public.transactions (val) values ('plaintext-only')");

    // T2 engages. With a plain SELECT in the trigger this returned immediately
    // and the gate then saw a quiet, empty, already-engaged database. With
    // FOR SHARE it must BLOCK until T1 finishes.
    const t2 = await session();
    let engageResolved = false;
    const engaging = t2
      .query('update public.encryption_cutover set engaged = true, engaged_at = now()')
      .then(() => { engageResolved = true; })
      .catch(() => { engageResolved = true; });

    await sleep(500);

    assert.equal(
      engageResolved, false,
      'engaging must block while a writer admitted before it is still open — that block IS the drain',
    );

    // What the gate would see at this instant: the barrier is NOT yet engaged, so
    // it fails closed instead of certifying a database with an invisible pending
    // plaintext row.
    const gate = await session();
    const flag = await gate.query('select engaged from public.encryption_cutover where id = true');
    assert.equal(
      flag.rows[0].engaged, false,
      'the gate must not see an engaged barrier while an admitted writer can still commit',
    );

    // Let T1 finish; the drain completes and engagement lands.
    await t1.query('commit');
    await engaging;
    assert.equal(engageResolved, true, 'engagement completes once the admitted writer is done');

    const after2 = await gate.query('select engaged from public.encryption_cutover where id = true');
    assert.equal(after2.rows[0].engaged, true);
  });
  await release();
});

test('CRITICAL REGRESSION: a writer arriving after engagement is rejected', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();
  await admin.query('update public.encryption_cutover set engaged = true, engaged_at = now()');

  await withSessions(async (session) => {
    const w = await session();
    await assert.rejects(
      () => w.query("insert into public.transactions (val) values ('nope')"),
      (err) => err.code === '25006',
      'writes during the cutover window must fail with read_only_sql_transaction',
    );
  });
  await release();
});

test('CRITICAL REGRESSION: TRUNCATE is guarded too', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();
  await admin.query("insert into public.transactions (val) values ('keep me')");
  await admin.query('update public.encryption_cutover set engaged = true, engaged_at = now()');

  // TRUNCATE is a separate trigger event. A trigger listing only
  // INSERT/UPDATE/DELETE does not fire for it, and pg_stat's tuple counters do
  // not record it either — so it emptied a table straight through the barrier
  // AND past the gate's independent witness.
  await withSessions(async (session) => {
    const w = await session();
    await assert.rejects(
      () => w.query('truncate public.transactions'),
      (err) => err.code === '25006',
      'TRUNCATE must be blocked by the barrier',
    );
  });

  await release();
  const left = await admin.query('select count(*)::int as n from public.transactions');
  assert.equal(left.rows[0].n, 0, 'sanity: release() cleans up');
});

test('every guarded table rejects writes, not just transactions', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();
  await admin.query('update public.encryption_cutover set engaged = true, engaged_at = now()');

  await withSessions(async (session) => {
    const w = await session();
    for (const table of GUARDED) {
      await assert.rejects(
        () => w.query(`insert into public.${table} (val) values ('x')`),
        (err) => err.code === '25006',
        `${table} is not guarded`,
      );
    }
  });
  await release();
});

test('releasing the barrier lets writes through again', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();
  await withSessions(async (session) => {
    const w = await session();
    await w.query("insert into public.transactions (val) values ('after release')");
    const n = await w.query('select count(*)::int as n from public.transactions');
    assert.equal(n.rows[0].n, 1);
  });
  await release();
});

test('the flag table itself is never guarded, so the barrier can always be released', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();
  await admin.query('update public.encryption_cutover set engaged = true, engaged_at = now()');
  // If encryption_cutover carried its own trigger, this would deadlock the
  // operator out of their own maintenance window.
  await admin.query('update public.encryption_cutover set engaged = false, engaged_at = null');
  const flag = await admin.query('select engaged from public.encryption_cutover where id = true');
  assert.equal(flag.rows[0].engaged, false);
});

test('the signup trigger no longer seeds categories, from 018a onward', async (t) => {
  if (guard()) return t.skip(skipReason);
  // Moved out of 019 after Codex's finding 4: the dual-write window starts here,
  // so plaintext-only category seeding has to stop here, not at the drop.
  const src = await admin.query(
    "select prosrc from pg_proc where proname = 'handle_new_user'",
  );
  assert.equal(src.rows.length, 1, 'the migration must (re)define handle_new_user');
  const body = src.rows[0].prosrc.replace(/--[^\n]*/g, '');
  assert.ok(!/insert\s+into\s+public\.categories/i.test(body), 'must not seed categories');
  assert.match(body, /insert\s+into\s+public\.user_stats/i, 'must still seed user_stats');
});

test('pg_stat counters lag, which is why they are only defence in depth', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();
  const counters = async () => {
    const r = await admin.query(
      `select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int as w
         from pg_stat_all_tables where schemaname = 'public' and relname = 'transactions'`);
    return r.rows[0].w;
  };
  const beforeCount = await counters();

  // An open, uncommitted writer. The point is simply that this number cannot be
  // the proof the gate relies on — the barrier is.
  const during = await withSessions(async (session) => {
    const t1 = await session();
    await t1.query('begin');
    await t1.query("insert into public.transactions (val) values ('pending')");
    const n = await counters();
    await t1.query('rollback');
    return n;
  });

  // Rolled back: no row exists, yet the counter may still have moved. Either way
  // the gate must not treat this as its authority.
  const rows = await admin.query('select count(*)::int as n from public.transactions');
  assert.equal(rows.rows[0].n, 0, 'the rolled-back row is really gone');
  assert.ok(typeof during === 'number' && during >= beforeCount);
  await release();
});


// --- Codex stage-5 RE-VERIFY #3 finding 1: the old-snapshot bypass -----------

test('CRITICAL REGRESSION: a snapshot older than the flag row cannot write through the barrier', async (t) => {
  if (guard()) return t.skip(skipReason);
  if (process.env.TEST_DATABASE_URL) {
    // Creating databases on somebody's real server is not this test's business.
    return t.skip('needs the embedded server (creates a scratch database)');
  }

  // Codex's probe, exactly. The trigger's `SELECT ... FOR SHARE` reads through the
  // CALLING transaction's snapshot, so a REPEATABLE READ transaction whose
  // snapshot predates 018a cannot see the flag row at all. The old code treated
  // "no row" as "no barrier" and let the write through:
  //     {"writeError":null,"committedRows":1}
  // Sequence that INSERT after the gate returns, and 019 drops the plaintext it
  // just committed.
  const { owner, info } = await databaseWithoutBarrier('barrier_oldsnapshot');
  const t1 = new Client(info);
  const engager = new Client(info);
  try {
    await t1.connect();
    await engager.connect();

    // 1. T1's snapshot is established BEFORE the barrier exists.
    await t1.query('begin isolation level repeatable read');
    await t1.query('select count(*) from public.transactions');

    // 2. The barrier is installed and engaged, both invisible to T1's snapshot.
    await owner.query(MIGRATION);
    await owner.query('update public.encryption_cutover set engaged = true');

    // 3. T1 writes. It MUST be refused.
    await assert.rejects(
      () => t1.query("insert into public.transactions (val) values ('past the barrier')"),
      (err) => err.code === '25006',
      'a transaction that cannot see the flag row must be refused, not waved through',
    );

    await t1.query('rollback');
    const left = await owner.query('select count(*)::int as n from public.transactions');
    assert.equal(left.rows[0].n, 0, 'nothing may have been committed through the engaged barrier');
  } finally {
    await t1.end().catch(() => {});
    await engager.end().catch(() => {});
    await owner.end().catch(() => {});
    await admin.query('drop database if exists barrier_oldsnapshot').catch(() => {});
  }
});

test('a deleted flag row refuses writes rather than silently disabling the barrier', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();
  await admin.query('delete from public.encryption_cutover');
  try {
    await withSessions(async (session) => {
      const w = await session();
      await assert.rejects(
        () => w.query("insert into public.transactions (val) values ('no flag row')"),
        (err) => err.code === '25006',
        'a barrier that cannot read its own flag must refuse',
      );
    });
  } finally {
    // The documented one-statement recovery.
    await admin.query('insert into public.encryption_cutover (id, engaged) values (true, false)');
  }
  await release();
});

// --- Codex stage-5 RE-VERIFY #3 finding 2: continuity the caller cannot forge -

test('CRITICAL REGRESSION: generation is database-owned and survives a forged timestamp', async (t) => {
  if (guard()) return t.skip(skipReason);
  await release();

  const read = async () => (await admin.query(
    'select engaged, engaged_at, generation from public.encryption_cutover where id = true')).rows[0];

  const start = await read();

  // Engage and release, deliberately writing the SAME engaged_at back both times
  // — which is what made the old `engaged_at` comparison forgeable.
  await admin.query(`update public.encryption_cutover set engaged = true, engaged_at = '2026-08-18T02:00:00Z'`);
  const engaged = await read();
  await admin.query(`update public.encryption_cutover set engaged = false, engaged_at = '2026-08-18T02:00:00Z'`);
  const released = await read();

  assert.ok(
    Number(engaged.generation) > Number(start.generation),
    'engaging must bump the generation',
  );
  assert.ok(
    Number(released.generation) > Number(engaged.generation),
    'releasing must bump it again, so a cycle is always visible',
  );
  // engaged_at is derived, not accepted from the caller.
  assert.notEqual(
    engaged.engaged_at && new Date(engaged.engaged_at).toISOString(),
    '2026-08-18T02:00:00.000Z',
    'the database must set engaged_at itself, not take the value it was handed',
  );
  assert.equal(released.engaged_at, null, 'releasing clears engaged_at');
  await release();
});

test('the generation trigger does not block releasing the barrier', async (t) => {
  if (guard()) return t.skip(skipReason);
  await admin.query('update public.encryption_cutover set engaged = true');
  await admin.query('update public.encryption_cutover set engaged = false');
  const flag = await admin.query('select engaged from public.encryption_cutover where id = true');
  assert.equal(flag.rows[0].engaged, false);
  await release();
});
