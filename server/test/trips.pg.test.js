/**
 * Migration 017b (Phase 18 trips), against a REAL PostgreSQL.
 *
 * The route suites run on a fake with no constraints, so only this file can tell
 * whether the CHECKs, the unique budget per category and the `set null` foreign keys
 * actually exist. It replays the ACTUAL files 001 onward against stubs of what
 * Supabase provides, because BUGS-FIXED 2026-09-23 #4 was a migration asserted to
 * replay that did not.
 *
 * Opt-in, exactly like writeBarrier.pg.test.js:
 *
 *     cd server && npm install --no-save pg embedded-postgres && npm test
 *
 * Embedded PostgreSQL only: a replay has no business running on a shared database,
 * so TEST_DATABASE_URL is ignored here.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = new URL('../migrations/', import.meta.url);
const ALL = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const read = (file) => readFileSync(new URL(file, DIR), 'utf8');
const LAST_BEFORE = '017a_subscription_tracking.sql';
const M017B = '017b_trips.sql';

const U = '00000000-0000-4000-8000-000000000001';

let pg = null;
let Client = null;
let port = null;
let skipReason = null;
let admin = null;
let replayError = null;
let category = null;
let incomeCategory = null;
let preGroup = null;

async function boot() {
  let EmbeddedPostgres;
  try {
    ({ Client } = await import('pg'));
    ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
  } catch {
    skipReason = 'the pg and embedded-postgres packages are not installed';
    return;
  }
  // A different range from writeBarrier and subscriptionTracking, which may run in parallel.
  port = 57500 + (process.pid % 900);
  pg = new EmbeddedPostgres({
    databaseDir: join(tmpdir(), `trim-017b-pg-${process.pid}`),
    user: 'trim', password: 'trim', port, persistent: false,
    onLog: () => {}, onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('trim017b');
}

const connect = async (database) => {
  const client = new Client({ host: 'localhost', port, user: 'trim', password: 'trim', database });
  await client.connect();
  return client;
};

/** What Supabase provides and the migrations reference. Stubs are enough. */
async function stubSupabase(client) {
  for (const role of ['postgres', 'anon', 'authenticated', 'service_role']) {
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if;
    end $$;`);
  }
  await client.query('create schema if not exists auth');
  await client.query('create table if not exists auth.users (id uuid primary key)');
  await client.query(`create or replace function auth.uid() returns uuid language sql stable
    as $$ select null::uuid $$`);
}

/** Apply the real files in order, naming the one that fails. */
async function replay(client, files) {
  for (const file of files) {
    try {
      await client.query(read(file));
    } catch (err) {
      throw new Error(`${file} failed to replay: ${err.message}`);
    }
  }
}

before(async () => {
  await boot();
  if (skipReason) return;
  admin = await connect('trim017b');
  await stubSupabase(admin);
  try {
    await replay(admin, ALL.filter((f) => f <= LAST_BEFORE));

    // Rows that already exist when 017b arrives, including a grouped special expense
    // and an income, which is what the two new CHECKs could trip over.
    await admin.query(`insert into auth.users (id) values ('${U}')`);
    const cats = await admin.query(
      `select id, type from public.categories where user_id = '${U}' order by sort_order`,
    );
    category = cats.rows.find((c) => c.type === 'expense').id;
    incomeCategory = cats.rows.find((c) => c.type === 'income').id;
    const group = await admin.query(
      `insert into public.special_groups (user_id, name) values ('${U}', 'Paris') returning id`,
    );
    preGroup = group.rows[0].id;
    await admin.query(
      `insert into public.transactions (user_id, category_id, amount, type, is_special, special_group_id)
       values ('${U}', '${category}', 10, 'expense', true, '${preGroup}'),
              ('${U}', '${incomeCategory}', 20, 'income', false, null)`,
    );

    await admin.query(read(M017B));
  } catch (err) {
    replayError = err;
  }
});

after(async () => {
  if (admin) await admin.end().catch(() => {});
  if (pg) await pg.stop().catch(() => {});
});

const guard = (t) => {
  if (!skipReason) {
    assert.equal(replayError, null, replayError?.message);
    return false;
  }
  console.warn(`  SKIPPED — ${skipReason}.\n  To run: cd server && npm install --no-save pg embedded-postgres && npm test`);
  t.skip(skipReason);
  return true;
};

/** Run a statement inside the caller's transaction; returns the error code or null. */
async function attempt(sql, params = []) {
  await admin.query('savepoint s');
  try {
    await admin.query(sql, params);
    await admin.query('release savepoint s');
    return null;
  } catch (err) {
    await admin.query('rollback to savepoint s').catch(() => {});
    return err.code;
  }
}

/** Every test works inside a transaction it rolls back, so tests can't affect each other. */
async function inTx(fn) {
  await admin.query('begin');
  try {
    await fn();
  } finally {
    await admin.query('rollback');
  }
}

const newTrip = async (overrides = {}) => {
  const t = { start_date: '2026-10-12', end_date: '2026-10-19', ...overrides };
  const { rows } = await admin.query(
    `insert into public.trips (user_id, name, start_date, end_date, source_group_id)
     values ($1, 'Italy', $2, $3, $4) returning id`,
    [U, t.start_date, t.end_date, t.source_group_id ?? null],
  );
  return rows[0].id;
};

const newStop = async (tripId) => {
  const { rows } = await admin.query(
    `insert into public.trip_stops (user_id, trip_id, name, start_date, end_date)
     values ($1, $2, 'Rome', '2026-10-12', '2026-10-15') returning id`,
    [U, tripId],
  );
  return rows[0].id;
};

const newTx = async (fields = {}) => {
  const { rows } = await admin.query(
    `insert into public.transactions (user_id, category_id, amount, type, trip_id, trip_stop_id)
     values ($1, $2, 10, 'expense', $3, $4) returning id`,
    [U, category, fields.trip_id ?? null, fields.trip_stop_id ?? null],
  );
  return rows[0].id;
};

test('a bare database replays 001 through 017b, and 017b applies AGAIN (replay-safe)', async (t) => {
  if (guard(t)) return;
  await admin.query('begin');
  try {
    await admin.query(read(M017B));
  } finally {
    await admin.query('commit');
  }
});

test('rows that existed before 017b survive it, with no trip', async (t) => {
  if (guard(t)) return;
  const { rows } = await admin.query(
    `select type, special_group_id, trip_id, trip_stop_id from public.transactions
     where user_id = '${U}' order by amount`,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].special_group_id, preGroup);
  for (const row of rows) {
    assert.equal(row.trip_id, null);
    assert.equal(row.trip_stop_id, null);
  }
});

test('reversed dates are rejected on trips and on stops; a single day is fine', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    assert.equal(
      await attempt(
        `insert into public.trips (user_id, name, start_date, end_date)
         values ($1, 'x', '2026-10-19', '2026-10-12')`,
        [U],
      ),
      '23514',
    );
    assert.equal(
      await attempt(
        `insert into public.trips (user_id, name, start_date, end_date)
         values ($1, 'x', '2026-10-12', '2026-10-12')`,
        [U],
      ),
      null,
    );
    const tripId = await newTrip();
    assert.equal(
      await attempt(
        `insert into public.trip_stops (user_id, trip_id, name, start_date, end_date)
         values ($1, $2, 'x', '2026-10-19', '2026-10-12')`,
        [U, tripId],
      ),
      '23514',
    );
  });
});

test('budgets must be positive when present; a stop currency must be a code', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const tripId = await newTrip();
    const trip = (budget) =>
      attempt(
        `insert into public.trips (user_id, name, start_date, end_date, total_budget)
         values ($1, 'x', '2026-10-12', '2026-10-19', $2)`,
        [U, budget],
      );
    assert.equal(await trip(0), '23514');
    assert.equal(await trip(null), null);

    const stop = (budget, currency) =>
      attempt(
        `insert into public.trip_stops (user_id, trip_id, name, start_date, end_date, budget, currency)
         values ($1, $2, 'x', '2026-10-12', '2026-10-13', $3, $4)`,
        [U, tripId, budget, currency],
      );
    assert.equal(await stop(0, null), '23514');
    assert.equal(await stop(50, 'eur'), '23514');
    assert.equal(await stop(50, 'EUR'), null);
    assert.equal(await stop(null, null), null);

    assert.equal(
      await attempt(
        `insert into public.trip_category_budgets (user_id, trip_id, category_id, amount_limit)
         values ($1, $2, $3, 0)`,
        [U, tripId, category],
      ),
      '23514',
    );
  });
});

test('one budget per category per trip, while another trip may use the category', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const budget = (tripId) =>
      attempt(
        `insert into public.trip_category_budgets (user_id, trip_id, category_id, amount_limit)
         values ($1, $2, $3, 100)`,
        [U, tripId, category],
      );
    const first = await newTrip();
    assert.equal(await budget(first), null);
    assert.equal(await budget(first), '23505');
    assert.equal(await budget(await newTrip()), null);
  });
});

test('CRITICAL: a transaction can have a trip or a special group, never both', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const tripId = await newTrip();
    assert.equal(
      await attempt(
        `insert into public.transactions (user_id, amount, type, trip_id, special_group_id)
         values ($1, 10, 'expense', $2, $3)`,
        [U, tripId, preGroup],
      ),
      '23514',
    );
    const onTrip = await newTx({ trip_id: tripId });
    assert.equal(
      await attempt('update public.transactions set special_group_id = $1 where id = $2', [preGroup, onTrip]),
      '23514',
    );
  });
});

test('CRITICAL: income can never be on a trip, by insert or by changing its type', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const tripId = await newTrip();
    assert.equal(
      await attempt(
        `insert into public.transactions (user_id, amount, type, trip_id) values ($1, 10, 'income', $2)`,
        [U, tripId],
      ),
      '23514',
    );
    const onTrip = await newTx({ trip_id: tripId });
    assert.equal(
      await attempt(`update public.transactions set type = 'income' where id = $1`, [onTrip]),
      '23514',
    );
  });
});

test('CRITICAL: deleting a trip keeps its spending, untagged, and removes its stops and budgets', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const tripId = await newTrip();
    const stopId = await newStop(tripId);
    await admin.query(
      `insert into public.trip_category_budgets (user_id, trip_id, category_id, amount_limit)
       values ($1, $2, $3, 100)`,
      [U, tripId, category],
    );
    const txId = await newTx({ trip_id: tripId, trip_stop_id: stopId });

    await admin.query('delete from public.trips where id = $1', [tripId]);

    const { rows } = await admin.query('select trip_id, trip_stop_id from public.transactions where id = $1', [txId]);
    assert.deepEqual(rows, [{ trip_id: null, trip_stop_id: null }]);
    const stops = await admin.query('select 1 from public.trip_stops where trip_id = $1', [tripId]);
    const budgets = await admin.query('select 1 from public.trip_category_budgets where trip_id = $1', [tripId]);
    assert.equal(stops.rowCount, 0);
    assert.equal(budgets.rowCount, 0);
  });
});

test('CRITICAL: deleting a stop keeps the spending on the trip and drops only the override', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const tripId = await newTrip();
    const stopId = await newStop(tripId);
    const txId = await newTx({ trip_id: tripId, trip_stop_id: stopId });

    await admin.query('delete from public.trip_stops where id = $1', [stopId]);

    const { rows } = await admin.query('select trip_id, trip_stop_id from public.transactions where id = $1', [txId]);
    assert.deepEqual(rows, [{ trip_id: tripId, trip_stop_id: null }]);
  });
});

test('deleting the group a trip came from leaves the trip, with no source', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const { rows: g } = await admin.query(
      `insert into public.special_groups (user_id, name) values ($1, 'Rome') returning id`,
      [U],
    );
    const tripId = await newTrip({ source_group_id: g[0].id });
    await admin.query('delete from public.special_groups where id = $1', [g[0].id]);
    const { rows } = await admin.query('select source_group_id from public.trips where id = $1', [tripId]);
    assert.deepEqual(rows, [{ source_group_id: null }]);
  });
});

test('deleting a category removes its trip budget line, not the trip (documented limit)', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const tripId = await newTrip();
    const { rows: c } = await admin.query(
      `insert into public.categories (user_id, name, type) values ($1, 'Temp', 'expense') returning id`,
      [U],
    );
    await admin.query(
      `insert into public.trip_category_budgets (user_id, trip_id, category_id, amount_limit)
       values ($1, $2, $3, 100)`,
      [U, tripId, c[0].id],
    );
    await admin.query('delete from public.categories where id = $1', [c[0].id]);
    const budgets = await admin.query('select 1 from public.trip_category_budgets where trip_id = $1', [tripId]);
    const trips = await admin.query('select 1 from public.trips where id = $1', [tripId]);
    assert.equal(budgets.rowCount, 0);
    assert.equal(trips.rowCount, 1);
  });
});

test('deleting an account cascades through trips, stops and tagged spending without error', async (t) => {
  if (guard(t)) return;
  await inTx(async () => {
    const tripId = await newTrip();
    const stopId = await newStop(tripId);
    await newTx({ trip_id: tripId, trip_stop_id: stopId });

    assert.equal(await attempt('delete from auth.users where id = $1', [U]), null);

    const left = await admin.query(
      `select (select count(*) from public.trips where user_id = $1)::int as trips,
              (select count(*) from public.transactions where user_id = $1)::int as txs`,
      [U],
    );
    assert.deepEqual(left.rows, [{ trips: 0, txs: 0 }]);
  });
});

test('all three tables have RLS on, four own-row policies, and the service-role grant', async (t) => {
  if (guard(t)) return;
  for (const table of ['trips', 'trip_stops', 'trip_category_budgets']) {
    const rls = await admin.query(
      `select relrowsecurity from pg_class where oid = $1::regclass`,
      [`public.${table}`],
    );
    assert.equal(rls.rows[0].relrowsecurity, true, `${table} has RLS on`);
    const policies = await admin.query(
      `select policyname from pg_policies where schemaname = 'public' and tablename = $1 order by 1`,
      [table],
    );
    assert.deepEqual(
      policies.rows.map((p) => p.policyname),
      ['delete', 'insert', 'select', 'update'].map((op) => `${table}_own_${op}`),
    );
    const grant = await admin.query(
      `select has_table_privilege('service_role', $1, 'select, insert, update, delete') as ok`,
      [`public.${table}`],
    );
    assert.equal(grant.rows[0].ok, true, `${table} is reachable by the API`);
  }
});

test('CRITICAL: the encryption migrations replay on top: 22 encrypted columns, 13 barriers, then 019', async (t) => {
  if (guard(t)) return;
  // An EMPTY database: 019's NOT NULLs correctly refuse rows that were never backfilled.
  await pg.createDatabase('trim019');
  const db = await connect('trim019');
  try {
    await stubSupabase(db);
    await replay(db, ALL.filter((f) => f <= '018a_encryption_write_barrier.sql'));

    const before = await db.query(
      `select
         (select count(*) from information_schema.columns
           where table_schema = 'public' and column_name like '%\\_enc')::int as enc_columns,
         (select count(*) from pg_trigger
           where tgname like '%\\_encryption\\_cutover\\_guard')::int as barriers`,
    );
    assert.deepEqual(before.rows[0], { enc_columns: 22, barriers: 13 });

    for (const table of ['trips', 'trip_stops', 'trip_category_budgets']) {
      const barrier = await db.query(
        `select 1 from pg_trigger where tgname = $1 and tgrelid = $2::regclass`,
        [`${table}_encryption_cutover_guard`, `public.${table}`],
      );
      assert.equal(barrier.rowCount, 1, `${table} has a write barrier`);
    }

    const last = ALL[ALL.length - 1];
    assert.equal(last, '019_encryption_drop_plaintext.sql', '019 must sort last');
    await replay(db, [last]);

    const cols = await db.query(
      `select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name in ('trips', 'trip_stops', 'trip_category_budgets')`,
    );
    const has = (table, column) => cols.rows.find((c) => c.table_name === table && c.column_name === column);
    for (const [table, column] of [
      ['trips', 'name'],
      ['trips', 'total_budget'],
      ['trip_stops', 'name'],
      ['trip_stops', 'budget'],
      ['trip_category_budgets', 'amount_limit'],
    ]) {
      assert.equal(has(table, column), undefined, `${table}.${column} is gone`);
    }
    assert.equal(has('trips', 'name_enc').is_nullable, 'NO');
    assert.equal(has('trip_stops', 'name_enc').is_nullable, 'NO');
    assert.equal(has('trip_category_budgets', 'amount_limit_enc').is_nullable, 'NO');
    assert.equal(has('trips', 'total_budget_enc').is_nullable, 'YES');
    assert.equal(has('trip_stops', 'budget_enc').is_nullable, 'YES');
    // Plaintext on purpose, and still there.
    assert.ok(has('trips', 'start_date'));
    assert.ok(has('trips', 'keep_out_of_monthly'));
    assert.ok(has('trip_stops', 'currency'));
  } finally {
    await db.end().catch(() => {});
  }
});
