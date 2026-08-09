import { test } from 'node:test';
import assert from 'node:assert/strict';

// The backfill imports crypto.js, which needs a key. Set one BEFORE importing.
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { runBackfill, parseArgs, JOBS, PAGE_SIZE } = await import('../scripts/encrypt-backfill.mjs');
const { decryptField } = await import('../lib/crypto.js');

/**
 * Minimal fake of the Supabase query builder — enough for the backfill's three
 * shapes: keyset select, update-by-pk, and re-select-by-pk. Every fault we need
 * to simulate is injected through `faults`.
 *
 * This exists because the backfill had ZERO tests despite being restructured
 * specifically to be testable, and the defect it shipped with (a verification
 * failure permanently hiding a row from re-runs) is only visible across TWO
 * runs — exactly what no manual check would catch.
 */
function makeFake(tables, faults = {}) {
  const writes = [];
  const api = {
    writes,
    from(table) {
      const rows = tables[table] ?? [];
      const q = {
        _mode: null, _filters: [], _isNull: null, _gt: null, _limit: null, _patch: null,
        select() { q._mode = 'select'; return q; },
        update(patch) { q._mode = 'update'; q._patch = patch; return q; },
        is(col, val) { if (val === null) q._isNull = col; return q; },
        not() { return q; },
        order() { return q; },
        limit(n) { q._limit = n; return q; },
        range() { return q; },
        gt(col, v) { q._gt = [col, v]; return q; },
        eq(col, v) { q._filters.push([col, v]); return q; },
        maybeSingle() { return q._runSelectOne(); },

        _match(r) { return q._filters.every(([c, v]) => r[c] === v); },

        _runSelectOne() {
          if (faults.selectError) return Promise.resolve({ data: null, error: new Error('transient PostgREST timeout') });
          const found = rows.find((r) => q._match(r));
          return Promise.resolve({ data: found ? { ...found } : null, error: null });
        },

        then(resolve, reject) {
          // Awaiting the builder directly = list select, or an update.
          if (q._mode === 'update') {
            const targets = rows.filter((r) => q._match(r));
            for (const r of targets) {
              Object.assign(r, q._patch);
              writes.push({ table, pk: { ...Object.fromEntries(q._filters) }, patch: { ...q._patch } });
            }
            // Simulate a column that mangles what it stores.
            if (faults.corruptColumn) {
              for (const r of targets) {
                if (r[faults.corruptColumn] != null) r[faults.corruptColumn] = 'v1:tampered:tampered:tampered';
              }
            }
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
          let out = rows.filter((r) => (q._isNull ? r[q._isNull] == null : true));
          if (q._gt) out = out.filter((r) => r[q._gt[0]] > q._gt[1]);
          out.sort((a, b) => (a.id > b.id ? 1 : -1));
          if (q._limit) out = out.slice(0, q._limit);
          return Promise.resolve({ data: out.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return api;
}

const JOB = [{ table: 'transactions', fields: [['amount', 'amount_enc']] }];
const silent = () => {};

test('encrypts every row and the stored ciphertext decrypts back', async () => {
  const tables = {
    transactions: [
      { id: 'a', user_id: 'u1', amount: 12.5, amount_enc: null },
      { id: 'b', user_id: 'u1', amount: 900, amount_enc: null },
    ],
  };
  const fake = makeFake(tables);
  const totals = await runBackfill({ supabase: fake, jobs: JOB, log: silent });
  assert.equal(totals.encrypted, 2);
  for (const r of tables.transactions) {
    assert.equal(decryptField(r.user_id, r.amount_enc), String(r.amount));
  }
});

test('dry run writes absolutely nothing', async () => {
  const tables = { transactions: [{ id: 'a', user_id: 'u1', amount: 5, amount_enc: null }] };
  const fake = makeFake(tables);
  await runBackfill({ supabase: fake, jobs: JOB, dryRun: true, log: silent });
  assert.equal(fake.writes.length, 0, 'dry run must not issue any write');
  assert.equal(tables.transactions[0].amount_enc, null);
});

test('a row whose plaintext is NULL terminates instead of looping forever', async () => {
  // The original Critical defect: paging on `.is(enc, null)` and expecting the
  // write to clear it. A NULL plaintext writes NULL and re-matches forever.
  const tables = {
    user_stats: [
      { user_id: 'u1', monthly_limit: null, monthly_limit_enc: null },
      { user_id: 'u2', monthly_limit: null, monthly_limit_enc: null },
    ],
  };
  const job = [{ table: 'user_stats', fields: [['monthly_limit', 'monthly_limit_enc']], pk: ['user_id'] }];
  const totals = await runBackfill({ supabase: makeFake(tables), jobs: job, log: silent });
  assert.equal(totals.encrypted, 0);
  assert.equal(totals.nothingToEncrypt, 2);
});

test('REGRESSION: a row that fails verification is rolled back so a re-run repairs it', async () => {
  // This is the defect that survived adversarial audit. Run 1 must NOT leave a
  // committed-but-unverified row, because the idempotency filter would then
  // hide it from run 2 forever and migration 013 would drop its plaintext.
  const tables = { transactions: [{ id: 'a', user_id: 'u1', amount: 12.5, amount_enc: null }] };
  const fake = makeFake(tables, { corruptColumn: 'amount_enc' });

  await assert.rejects(
    () => runBackfill({ supabase: fake, jobs: JOB, log: silent }),
    /VERIFY FAILED/,
    'a corrupted store must abort the run',
  );

  assert.equal(
    tables.transactions[0].amount_enc, null,
    'the unverified write must be rolled back to NULL, or the re-run skips this row forever',
  );

  // Run 2, with the fault cleared, must now SEE and fix the row.
  const fake2 = makeFake(tables);
  const totals = await runBackfill({ supabase: fake2, jobs: JOB, log: silent });
  assert.equal(totals.encrypted, 1, 're-run must pick the row back up');
  assert.equal(decryptField('u1', tables.transactions[0].amount_enc), '12.5');
});

test('REGRESSION: a transient read error after the write also rolls back', async () => {
  // The realistic path: nothing wrong with the data, just a PostgREST blip on
  // the read-back. Still leaves an unverified row unless we roll it back.
  const tables = { transactions: [{ id: 'a', user_id: 'u1', amount: 40, amount_enc: null }] };
  const fake = makeFake(tables, { selectError: true });
  await assert.rejects(() => runBackfill({ supabase: fake, jobs: JOB, log: silent }));
  assert.equal(
    tables.transactions[0].amount_enc, null,
    'a transient read failure must not strand the row outside the idempotency filter',
  );
});

test('already-encrypted rows are skipped, so a re-run is genuinely idempotent', async () => {
  const tables = { transactions: [{ id: 'a', user_id: 'u1', amount: 7, amount_enc: null }] };
  const first = await runBackfill({ supabase: makeFake(tables), jobs: JOB, log: silent });
  assert.equal(first.encrypted, 1);
  const ciphertext = tables.transactions[0].amount_enc;

  const second = await runBackfill({ supabase: makeFake(tables), jobs: JOB, log: silent });
  assert.equal(second.encrypted, 0, 'second run must not re-encrypt');
  assert.equal(tables.transactions[0].amount_enc, ciphertext, 'ciphertext must be left alone');
});

test('paging terminates on a table larger than one page', async () => {
  const rows = Array.from({ length: PAGE_SIZE + 25 }, (_, i) => ({
    id: String(i).padStart(5, '0'), user_id: 'u1', amount: i + 1, amount_enc: null,
  }));
  const totals = await runBackfill({ supabase: makeFake({ transactions: rows }), jobs: JOB, log: silent });
  assert.equal(totals.encrypted, PAGE_SIZE + 25);
});

test('parseArgs refuses an unknown flag rather than performing a live run', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseArgs([]), { dryRun: false });
  for (const typo of ['--dryrun', '--dry_run', '--dry-run=true', '-d']) {
    assert.throws(() => parseArgs([typo]), /Unknown option/, `${typo} must not silently run live`);
  }
});

test('JOBS scope: money is encrypted, searchable text is deliberately left alone', () => {
  const pairs = JOBS.flatMap((j) => j.fields.map(([p]) => `${j.table}.${p}`));
  // Encrypting these would break DB-side queries that no decrypt-after-fetch fixes.
  assert.ok(!pairs.includes('transactions.description'), 'ILIKE-searched in routes/categories.js');
  assert.ok(!pairs.includes('categories.name'), 'matched by name in lib/categoryKeywords.js');
  // These are the point of the exercise.
  for (const must of ['transactions.amount', 'budgets.amount_limit', 'user_stats.monthly_limit', 'recurrences.amount']) {
    assert.ok(pairs.includes(must), `${must} must be encrypted`);
  }
});
