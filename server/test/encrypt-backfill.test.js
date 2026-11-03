import { test } from 'node:test';
import assert from 'node:assert/strict';

// The backfill imports crypto.js, which needs a key. Set one BEFORE importing.
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { runBackfill: runBackfillStrict, parseArgs, JOBS, PAGE_SIZE, blindValueFor } = await import('../scripts/encrypt-backfill.mjs');
// Most fixtures below start with nothing encrypted, which a real run refuses
// because there is nothing to test the key against. The refusal has its own tests.
const runBackfill = (opts) => runBackfillStrict({ requireKeyEvidence: false, ...opts });
const { decryptField, encryptField } = await import('../lib/crypto.js');
const { fieldKey } = await import('../lib/encryptedFields.js');

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
        _mode: null, _filters: [], _isNull: null, _gt: null, _limit: null, _patch: null, _range: null, _cols: null,
        select(cols) { q._mode = 'select'; q._cols = cols ?? null; return q; },
        update(patch) { q._mode = 'update'; q._patch = patch; return q; },
        is(col, val) { if (val === null) q._isNull = col; return q; },
        not() { return q; },
        order() { return q; },
        limit(n) { q._limit = n; return q; },
        range(from, to) { q._range = [from, to]; return q; },
        gt(col, v) { q._gt = [col, v]; return q; },
        eq(col, v) { q._filters.push([col, v]); return q; },
        maybeSingle() { return q._runSelectOne(); },

        _match(r) { return q._filters.every(([c, v]) => r[c] === v); },

        // Hand back only the columns the query asked for, as PostgREST does. Without
        // this, a scan that forgot to SELECT an `_enc` column would still see it here
        // and pass, while in production it reads `undefined` for every row.
        _project(r) {
          if (!q._cols || q._cols === '*') return { ...r };
          const out = {};
          for (const c of String(q._cols).split(',').map((s) => s.trim()).filter(Boolean)) {
            out[c] = r[c] === undefined ? null : r[c];
          }
          return out;
        },

        _runSelectOne() {
          if (faults.selectError) return Promise.resolve({ data: null, error: new Error('transient PostgREST timeout') });
          const found = rows.find((r) => q._match(r));
          return Promise.resolve({ data: found ? q._project(found) : null, error: null });
        },

        then(resolve, reject) {
          // Awaiting the builder directly = list select, or an update.
          if (q._mode === 'update') {
            const targets = rows.filter((r) => q._match(r));
            for (const r of targets) {
              Object.assign(r, q._patch);
              writes.push({ table, pk: { ...Object.fromEntries(q._filters) }, patch: { ...q._patch } });
            }
            // Simulate a live user editing the row between our SELECT and our
            // UPDATE — the row is committed, but with a value we never saw.
            if (faults.editPlaintextAfterWrite) {
              for (const r of targets) {
                const [col, val] = faults.editPlaintextAfterWrite;
                if (r[col] != null) r[col] = val;
              }
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
          const key = (r) => (r.id !== undefined ? String(r.id) : `${r.user_id}|${r.merchant_key}`);
          out.sort((a, b) => (key(a) > key(b) ? 1 : -1));
          if (q._range) out = out.slice(q._range[0], q._range[1] + 1);
          if (q._limit) out = out.slice(0, q._limit);
          return Promise.resolve({ data: out.map((r) => q._project(r)), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return api;
}

const F = (table, column) => ({ table, column, enc: `${column}_enc`, kind: 'amount' });
const JOB = [{ table: 'transactions', pk: ['id'], fields: [F('transactions', 'amount')] }];
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
    assert.equal(decryptField('transactions.amount', r.user_id, r.amount_enc), String(r.amount));
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
  const job = [{ table: 'user_stats', pk: ['user_id'], fields: [F('user_stats', 'monthly_limit')] }];
  const totals = await runBackfill({ supabase: makeFake(tables), jobs: job, log: silent });
  assert.equal(totals.encrypted, 0);
  assert.equal(totals.nothingToEncrypt, 2);
});

test('REGRESSION: a row that fails verification is rolled back so a re-run repairs it', async () => {
  // This is the defect that survived adversarial audit. Run 1 must NOT leave a
  // committed-but-unverified row, because the idempotency filter would then
  // hide it from run 2 forever and migration 019 would drop its plaintext.
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
  assert.equal(decryptField('transactions.amount', 'u1', tables.transactions[0].amount_enc), '12.5');
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
  // The guard used to inspect only arguments starting with '-', so the likeliest
  // typo of all — forgetting the dashes — parsed as "no flags" and performed a
  // LIVE write pass against real user data. [audit 2026-08-18]
  for (const typo of ['dry-run', 'dryrun', 'DRY-RUN', 'dry']) {
    assert.throws(() => parseArgs([typo]), /Unknown option/, `bare '${typo}' must not silently run live`);
  }
});

test('JOBS scope: money and free text are encrypted', () => {
  const pairs = JOBS.flatMap((j) => j.fields.map((f) => fieldKey(j.table, f.column)));
  // categories.name is looked up with `.eq('name', …)` in the database
  // (routes/categories.js:112) and is only the 12 seeded defaults, so it stays.
  // transactions.description WAS excluded until 2026-08-18. It is now encrypted,
  // and merchant memory searches a blind index instead.
  assert.ok(pairs.includes('transactions.description'), 'descriptions must be encrypted');
  // categories.name was excluded on the false premise that it is only the 12
  // seeded defaults. Users can POST any name. [Codex stage-4 VERIFY]
  assert.ok(pairs.includes('categories.name'), 'custom category names must be encrypted');
  // These are the point of the exercise.
  for (const must of [
    'transactions.amount',
    'transactions.original_amount', // amount = original_amount * fx_rate
    'budgets.amount_limit',
    'user_stats.monthly_limit',
    'recurrences.amount',
  ]) {
    assert.ok(pairs.includes(must), `${must} must be encrypted`);
  }
});

// --- fixes from the 2026-08-18 audit ----------------------------------------

test('REGRESSION: a row edited mid-run is rolled back, not "verified" as the old value', async () => {
  // The backfill SELECTs, then encrypts what it read, then writes. If a user
  // edits the row in between, the old code compared the stored ciphertext
  // against its own stale snapshot and passed — so migration 019 would drop the
  // only correct copy and the transaction would be the OLD amount forever.
  // Verification now compares against the database's CURRENT plaintext.
  const tables = { transactions: [{ id: 'a', user_id: 'u1', amount: 250, amount_enc: null }] };
  const fake = makeFake(tables, { editPlaintextAfterWrite: ['amount', 25] });

  await assert.rejects(
    () => runBackfill({ supabase: fake, jobs: JOB, log: silent }),
    /VERIFY FAILED \(database round-trip mismatch/,
    'an edit landing mid-row must abort, not pass',
  );
  assert.equal(
    tables.transactions[0].amount_enc, null,
    'the stale ciphertext must be rolled back so the re-run re-encrypts the NEW value',
  );

  // Re-run against the settled row now stores 25, not 250.
  await runBackfill({ supabase: makeFake(tables), jobs: JOB, log: silent });
  assert.equal(decryptField('transactions.amount', 'u1', tables.transactions[0].amount_enc), '25');
});

test('an empty table is reported as suspicious, not as success', async () => {
  // "0 rows encrypted" is identical output for "already done" and for "you are
  // pointed at the wrong database". The run must say which.
  const lines = [];
  const totals = await runBackfill({
    supabase: makeFake({ transactions: [] }),
    jobs: JOB,
    log: (m) => lines.push(m),
  });
  assert.equal(totals.scanned, 0);
  const out = lines.join('\n');
  assert.match(out, /NO ROWS AT ALL/);
  assert.match(out, /NOT evidence that encryption is complete/);
});

test('the backfill scope is the shared registry, not a list this script owns', async () => {
  // verify-encryption.mjs used to import JOBS from here, so the gate's scope was
  // defined by the script it audited. Both now read lib/encryptedFields.js.
  const { ENCRYPTED_FIELDS } = await import('../lib/encryptedFields.js');
  const fromJobs = JOBS.flatMap((j) => j.fields.map((f) => fieldKey(j.table, f.column))).sort();
  const fromRegistry = ENCRYPTED_FIELDS.map((f) => fieldKey(f.table, f.column)).sort();
  assert.deepEqual(fromJobs, fromRegistry);
});

// --- blind indexes and the composite-PK path --------------------------------

test('a blind index is written alongside the ciphertext and recomputes correctly', async () => {
  const { blindIndexMany } = await import('../lib/crypto.js');
  const { merchantPrefixes } = await import('../lib/merchant.js');
  const job = [{
    table: 'transactions',
    pk: ['id'],
    fields: [{ table: 'transactions', column: 'description', enc: 'description_enc', kind: 'text' }],
    blind: [{ table: 'transactions', column: 'merchant_prefix_hmacs', from: 'description', normalise: 'merchantPrefixes', multi: true }],
  }];
  const tables = {
    transactions: [{ id: 'a', user_id: 'u1', description: "Sainsbury's Local 442", description_enc: null, merchant_prefix_hmacs: null }],
  };
  await runBackfill({ supabase: makeFake(tables), jobs: job, log: silent });
  const row = tables.transactions[0];
  assert.equal(decryptField('transactions.description', 'u1', row.description_enc), "Sainsbury's Local 442");
  assert.deepEqual(
    row.merchant_prefix_hmacs,
    blindIndexMany('transactions.merchant_prefix_hmacs', 'u1', merchantPrefixes("Sainsbury's Local 442")),
    'the stored index must equal what the read path will hash',
  );
  assert.ok(
    !row.merchant_prefix_hmacs.join(' ').toLowerCase().includes('sainsbury'),
    'the index must not contain the merchant',
  );
});

test('two transactions at the same merchant share an index; different merchants do not', async () => {
  // This IS the privacy trade, made explicit: equal merchants are visibly equal.
  const job = [{
    table: 'transactions',
    pk: ['id'],
    fields: [{ table: 'transactions', column: 'description', enc: 'description_enc', kind: 'text' }],
    blind: [{ table: 'transactions', column: 'merchant_prefix_hmacs', from: 'description', normalise: 'merchantPrefixes', multi: true }],
  }];
  const tables = {
    transactions: [
      { id: 'a', user_id: 'u1', description: 'Tesco Express 1234', description_enc: null, merchant_prefix_hmacs: null },
      { id: 'b', user_id: 'u1', description: 'TESCO EXPRESS 9999', description_enc: null, merchant_prefix_hmacs: null },
      { id: 'c', user_id: 'u1', description: 'Boots 55', description_enc: null, merchant_prefix_hmacs: null },
    ],
  };
  await runBackfill({ supabase: makeFake(tables), jobs: job, log: silent });
  const [a, b, c] = tables.transactions;
  assert.deepEqual(a.merchant_prefix_hmacs, b.merchant_prefix_hmacs, 'same merchant, different case/suffix -> same index');
  assert.notDeepEqual(a.merchant_prefix_hmacs, c.merchant_prefix_hmacs);
});

test('the same merchant under two users hashes differently', async () => {
  // Per-user index keys: one leaked backup must not let anyone correlate
  // spending across every user at once.
  const job = [{
    table: 'transactions',
    pk: ['id'],
    fields: [{ table: 'transactions', column: 'description', enc: 'description_enc', kind: 'text' }],
    blind: [{ table: 'transactions', column: 'merchant_prefix_hmacs', from: 'description', normalise: 'merchantPrefixes', multi: true }],
  }];
  const tables = {
    transactions: [
      { id: 'a', user_id: 'u1', description: 'Netflix', description_enc: null, merchant_prefix_hmacs: null },
      { id: 'b', user_id: 'u2', description: 'Netflix', description_enc: null, merchant_prefix_hmacs: null },
    ],
  };
  await runBackfill({ supabase: makeFake(tables), jobs: job, log: silent });
  assert.notDeepEqual(tables.transactions[0].merchant_prefix_hmacs, tables.transactions[1].merchant_prefix_hmacs);
});

test('a rolled-back row loses its blind index too', async () => {
  // Otherwise a row whose ciphertext was rolled back is still findable by
  // merchant — the exact leak the index is supposed to be a controlled version of.
  const job = [{
    table: 'transactions',
    pk: ['id'],
    fields: [{ table: 'transactions', column: 'description', enc: 'description_enc', kind: 'text' }],
    blind: [{ table: 'transactions', column: 'merchant_prefix_hmacs', from: 'description', normalise: 'merchantPrefixes', multi: true }],
  }];
  const tables = {
    transactions: [{ id: 'a', user_id: 'u1', description: 'Boots', description_enc: null, merchant_prefix_hmacs: null }],
  };
  await assert.rejects(() =>
    runBackfill({ supabase: makeFake(tables, { corruptColumn: 'description_enc' }), jobs: job, log: silent }));
  assert.equal(tables.transactions[0].description_enc, null);
  assert.equal(tables.transactions[0].merchant_prefix_hmacs, null, 'the index must be rolled back with the ciphertext');
});

test('a composite-PK table is paged and encrypted, not skipped', async () => {
  // subscription_overrides (user_id + merchant_key). The offset path was briefly
  // deleted as dead code; this table is why it has to exist.
  const job = [{
    table: 'subscription_overrides',
    pk: ['user_id', 'merchant_key'],
    fields: [{ table: 'subscription_overrides', column: 'display_name', enc: 'display_name_enc', kind: 'text' }],
    blind: [{ table: 'subscription_overrides', column: 'merchant_key_hmac', from: 'merchant_key', normalise: 'identity' }],
  }];
  const tables = {
    subscription_overrides: [
      { user_id: 'u1', merchant_key: 'netflix', display_name: 'Netflix', display_name_enc: null, merchant_key_hmac: null },
      { user_id: 'u1', merchant_key: 'auto:cat1:25:monthly', display_name: 'Gym', display_name_enc: null, merchant_key_hmac: null },
    ],
  };
  const totals = await runBackfill({ supabase: makeFake(tables), jobs: job, log: silent });
  assert.equal(totals.encrypted, 2);
  for (const r of tables.subscription_overrides) {
    assert.equal(decryptField('subscription_overrides.display_name', r.user_id, r.display_name_enc), r.display_name);
    assert.ok(r.merchant_key_hmac, 'the plaintext merchant key must get a hashed replacement');
  }
  // The synthetic key embeds an amount bucket; the hash must not.
  assert.ok(!tables.subscription_overrides[1].merchant_key_hmac.includes('25'));
});

// --- half-encrypted rows (2026-11-01) ---------------------------------------
//
// At ENCRYPTION_PHASE=dual a route encrypts only the columns its write touches
// (lib/encryptionCodec.js encodeWrite: "a partial update stays partial"). So a
// row created at `off` and then edited at `dual` comes out half-encrypted: a
// PATCH of a transaction's amount writes amount_enc and nothing else. The scan
// used to decide "already done" from the table's FIRST `_enc` column alone, so
// that row was skipped on every run while the gate failed on its description —
// and no re-run could ever repair it. Same for a goal created at `dual`: the
// insert has no current_amount, the database default fills the plaintext with
// 0, and nothing writes current_amount_enc.

/** A row of `job`'s table with every field and blind index already correct. */
function fullyEncryptedRow(job, userId = 'u1') {
  const row = { user_id: userId };
  if (job.pk.includes('id')) row.id = 'r1';
  for (const f of job.fields) {
    row[f.column] = f.kind === 'amount' ? 12.5 : `${f.column} text`;
    row[f.enc] = encryptField(fieldKey(job.table, f.column), userId, String(row[f.column]));
  }
  for (const b of job.blind ?? []) row[b.column] = blindValueFor(job.table, b, row);
  return row;
}

test('REGRESSION: a row whose first _enc is set but a later one is missing is picked up', async () => {
  // Exactly what `PATCH /api/transactions/:id {amount}` leaves behind at dual on
  // a row created at off.
  const job = JOBS.find((j) => j.table === 'transactions');
  const amountEnc = encryptField('transactions.amount', 'u1', '25');
  const tables = {
    transactions: [{
      id: 'a', user_id: 'u1',
      amount: 25, amount_enc: amountEnc,
      original_amount: null, original_amount_enc: null,
      description: 'Tesco Express 1234', description_enc: null, merchant_prefix_hmacs: null,
    }],
  };
  const totals = await runBackfill({ supabase: makeFake(tables), jobs: [job], log: silent });
  const row = tables.transactions[0];
  assert.equal(totals.encrypted, 1, 'the half-encrypted row must not be skipped');
  assert.equal(decryptField('transactions.description', 'u1', row.description_enc), 'Tesco Express 1234');
  assert.deepEqual(
    row.merchant_prefix_hmacs,
    blindValueFor('transactions', job.blind[0], row),
    'its missing merchant index must be written too',
  );

  // And the re-run the runbook invites now has nothing left to do.
  const fake2 = makeFake(tables);
  const again = await runBackfill({ supabase: fake2, jobs: [job], log: silent });
  assert.equal(again.encrypted, 0);
  assert.equal(fake2.writes.length, 0, 'a completed row must not be rewritten');
});

test('REGRESSION: a goal created at dual gets its current_amount_enc (the DB default 0)', async () => {
  // POST /api/goals inserts name + target_amount only; Postgres fills
  // current_amount with its default. 0 is falsy, so this also guards against a
  // `!value` check treating a real zero as "nothing to encrypt".
  const job = JOBS.find((j) => j.table === 'savings_goals');
  const tables = {
    savings_goals: [{
      id: 'g1', user_id: 'u1',
      name: 'Holiday', name_enc: encryptField('savings_goals.name', 'u1', 'Holiday'),
      target_amount: 500, target_amount_enc: encryptField('savings_goals.target_amount', 'u1', '500'),
      current_amount: 0, current_amount_enc: null,
    }],
  };
  const totals = await runBackfill({ supabase: makeFake(tables), jobs: [job], log: silent });
  assert.equal(totals.encrypted, 1);
  assert.equal(decryptField('savings_goals.current_amount', 'u1', tables.savings_goals[0].current_amount_enc), '0');
});

test('REGRESSION: a row missing ANY one _enc column is picked up, on every table and both scan paths', async () => {
  // Driven by the registry, so a table or column added later is covered without
  // anyone remembering to add a case. subscription_overrides takes the
  // composite-key (offset) path, which had the same first-column check.
  for (const job of JOBS) {
    for (const missing of job.fields) {
      const row = fullyEncryptedRow(job);
      row[missing.enc] = null;
      const tables = { [job.table]: [row] };
      const totals = await runBackfill({ supabase: makeFake(tables), jobs: [job], log: silent });
      const where = `${job.table}.${missing.column}`;
      assert.equal(totals.encrypted, 1, `${where}: a row with only this column missing must be picked up`);
      assert.equal(
        decryptField(fieldKey(job.table, missing.column), 'u1', row[missing.enc]),
        String(row[missing.column]),
        `${where}: the missing column must now decrypt to its plaintext`,
      );
    }
  }
});

test('only the MISSING columns are written; ciphertext a route already wrote is left alone', async () => {
  for (const job of JOBS) {
    for (const missing of job.fields) {
      const row = fullyEncryptedRow(job);
      row[missing.enc] = null;
      const before = { ...row };
      const fake = makeFake({ [job.table]: [row] });
      await runBackfill({ supabase: fake, jobs: [job], log: silent });
      const where = `${job.table}.${missing.column}`;
      assert.equal(fake.writes.length, 1, `${where}: one write, no rollback`);
      assert.deepEqual(Object.keys(fake.writes[0].patch), [missing.enc], `${where}: write only the gap`);
      for (const f of job.fields) {
        if (f !== missing) assert.equal(row[f.enc], before[f.enc], `${where}: ${f.enc} must be untouched`);
      }
    }
  }
});

test('a blind index that is missing beside its ciphertext is repaired', async () => {
  // The gate fails a row whose index does not recompute from its plaintext, so
  // the backfill must be able to fix that state too, or a re-run cannot help.
  const job = JOBS.find((j) => j.table === 'categories');
  const row = fullyEncryptedRow(job);
  const want = row.name_hmac;
  row.name_hmac = null;
  const fake = makeFake({ categories: [row] });
  const totals = await runBackfill({ supabase: fake, jobs: [job], log: silent });
  assert.equal(totals.encrypted, 1);
  assert.equal(row.name_hmac, want);
  assert.deepEqual(Object.keys(fake.writes[0].patch), ['name_hmac'], 'the ciphertext was fine; leave it');
});

test('a fully encrypted row is left alone and counted as already encrypted, on every table', async () => {
  for (const job of JOBS) {
    const fake = makeFake({ [job.table]: [fullyEncryptedRow(job)] });
    const totals = await runBackfill({ supabase: fake, jobs: [job], log: silent });
    assert.equal(fake.writes.length, 0, `${job.table}: nothing to write`);
    assert.equal(totals.encrypted, 0, job.table);
    assert.equal(totals.alreadyEncrypted, 1, `${job.table}: reported as already encrypted`);
  }
});

test('a legitimately NULL optional column is not mistaken for a missing one', async () => {
  // original_amount is NULL on every home-currency transaction. Its `_enc` is
  // NULL too, correctly; treating that as "missing" would rewrite the row forever.
  const job = JOBS.find((j) => j.table === 'transactions');
  const row = fullyEncryptedRow(job);
  row.original_amount = null;
  row.original_amount_enc = null;
  const fake = makeFake({ transactions: [row] });
  const totals = await runBackfill({ supabase: fake, jobs: [job], log: silent });
  assert.equal(fake.writes.length, 0);
  assert.equal(totals.encrypted, 0);
});

test('REGRESSION: a failed verify rolls back only what THIS run wrote', async () => {
  // Rolling back every `_enc` column would also erase ciphertext a route wrote
  // correctly. Harmless before 019 (a re-run rewrites it), but it is not ours to
  // erase, and the row reappears for the re-run either way.
  const job = JOBS.find((j) => j.table === 'transactions');
  const row = fullyEncryptedRow(job);
  const amountEnc = row.amount_enc;
  row.description_enc = null;
  const tables = { transactions: [row] };

  await assert.rejects(
    () => runBackfill({ supabase: makeFake(tables, { corruptColumn: 'description_enc' }), jobs: [job], log: silent }),
    /VERIFY FAILED/,
  );
  assert.equal(row.description_enc, null, 'our unverified write must be rolled back');
  assert.equal(row.amount_enc, amountEnc, 'ciphertext we did not write must survive the rollback');

  const totals = await runBackfill({ supabase: makeFake(tables), jobs: [job], log: silent });
  assert.equal(totals.encrypted, 1, 'the re-run picks the row back up');
  assert.equal(decryptField('transactions.description', 'u1', row.description_enc), row.description);
});

// --- stale and orphaned ciphertext (2026-11-01, from the independent review) --
//
// The runbook's own undo for Step 3 is "set ENCRYPTION_PHASE back to off". An
// edit made there changes the plaintext and leaves the old `_enc` beside it. The
// old scan repaired that only by accident (it rewrote every column of a row whose
// FIRST `_enc` was NULL); the per-column fix must repair it on purpose, or the
// gate fails "ciphertext is STALE" and no re-run helps.

test('REGRESSION: a STALE ciphertext (edited back at off) is re-encrypted from the plaintext', async () => {
  const job = JOBS.find((j) => j.table === 'transactions');
  const row = fullyEncryptedRow(job);
  const amountEnc = row.amount_enc;
  // Encrypted as "Tesco" at dual, then renamed to "Aldi" while back at off.
  row.description_enc = encryptField('transactions.description', 'u1', 'Tesco');
  row.merchant_prefix_hmacs = blindValueFor('transactions', job.blind[0], { ...row, description: 'Tesco' });
  row.description = 'Aldi';
  const fake = makeFake({ transactions: [row] });

  const totals = await runBackfill({ supabase: fake, jobs: [job], log: silent });
  assert.equal(totals.encrypted, 1);
  assert.equal(decryptField('transactions.description', 'u1', row.description_enc), 'Aldi');
  assert.deepEqual(row.merchant_prefix_hmacs, blindValueFor('transactions', job.blind[0], row));
  assert.deepEqual(Object.keys(fake.writes[0].patch).sort(), ['description_enc', 'merchant_prefix_hmacs']);
  assert.equal(row.amount_enc, amountEnc, 'a correct column is still left alone');
});

test('REGRESSION: ciphertext beside a plaintext cleared back at off is cleared', async () => {
  // A foreign expense switched to home currency at off: original_amount NULL,
  // its old `_enc` still set. The gate counts it "encrypted-but-plaintext-cleared".
  const job = JOBS.find((j) => j.table === 'transactions');
  const row = fullyEncryptedRow(job);
  row.original_amount = null;
  const fake = makeFake({ transactions: [row] });

  const totals = await runBackfill({ supabase: fake, jobs: [job], log: silent });
  assert.equal(totals.encrypted, 1);
  assert.equal(row.original_amount_enc, null);
  assert.deepEqual(Object.keys(fake.writes[0].patch), ['original_amount_enc']);
});

test('CRITICAL: under the WRONG key the run refuses to start and writes nothing, in any table', async () => {
  // The likeliest operator mistake: server/.env holds a different key from the
  // one production encrypts with. Without this check the run would fill every
  // gap and rewrite every blind index (each looks stale under another key) with
  // values the live app cannot read — merchant suggestions break at once — and
  // a gate run under the same wrong key would happily agree with it.
  const tx = JOBS.find((j) => j.table === 'transactions');
  const cats = JOBS.find((j) => j.table === 'categories');
  const gappy = fullyEncryptedRow(tx); // written by production's key...
  gappy.description_enc = null; // ...with one real gap the run would otherwise fill
  const tables = { transactions: [gappy], categories: [fullyEncryptedRow(cats)] };
  const before = JSON.stringify(tables);
  const fake = makeFake(tables);

  const productionKey = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64'); // the wrong one
  let err;
  try {
    await runBackfill({ supabase: fake, jobs: [tx, cats], log: silent });
  } catch (e) {
    err = e;
  } finally {
    process.env.DATA_ENCRYPTION_KEY = productionKey;
  }

  assert.ok(err, 'the run must refuse');
  assert.match(err.message, /REFUSING TO START/);
  assert.match(err.message, /0 other\(s\) did/, 'none readable is how a wrong key looks');
  assert.match(err.message, /DATA_ENCRYPTION_KEY/);
  assert.match(err.message, /backup/, 'compare against the offline backup, not only Vercel');
  assert.equal(fake.writes.length, 0, 'not one write — no gap, no blind index, no table');
  assert.equal(JSON.stringify(tables), before);
});

test('one damaged ciphertext stops even a dry run, naming it by primary key only', async () => {
  // A handful unreadable among many readable means damage, not a wrong key. The
  // operator still has to look before anything is written, and the dry run the
  // runbook asks for first is where they should find out.
  const job = JOBS.find((j) => j.table === 'transactions');
  const ok = fullyEncryptedRow(job);
  const damaged = { ...fullyEncryptedRow(job), id: 'r2' };
  damaged.description_enc = encryptField('transactions.description', 'u2', damaged.description); // not u1's
  const fake = makeFake({ transactions: [ok, damaged] });

  await assert.rejects(
    () => runBackfill({ supabase: fake, jobs: [job], dryRun: true, log: silent }),
    (e) => {
      assert.match(e.message, /REFUSING TO START — 1 encrypted value/);
      assert.match(e.message, /transactions id=r2 description_enc/);
      assert.ok(!e.message.includes(damaged.description), 'never print user data');
      return true;
    },
  );
  assert.equal(fake.writes.length, 0);
});

/** Run `fn` with a different key in place, as if server/.env held the wrong one. */
async function underWrongKey(fn) {
  const productionKey = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  try {
    return await fn();
  } finally {
    process.env.DATA_ENCRYPTION_KEY = productionKey;
  }
}

test('a value that turns unreadable after the key check stops the run, unwritten', async () => {
  // Under a wrong key, a production row landing after the check is the strongest
  // signal there is. Going on would overwrite that row's blind index.
  const job = JOBS.find((j) => j.table === 'transactions');
  const row = fullyEncryptedRow(job);
  const foreign = encryptField('transactions.description', 'u2', row.description);
  const fake = makeFake({ transactions: [row] });
  await assert.rejects(
    () => runBackfill({
      supabase: fake,
      jobs: [job],
      log: (m) => {
        if (/^Key check/.test(m)) {
          row.description_enc = foreign;
          row.merchant_prefix_hmacs = null; // would otherwise be rewritten
        }
      },
    }),
    /will not decrypt/,
  );
  assert.equal(row.description_enc, foreign);
  assert.equal(fake.writes.length, 0);
});

test('with nothing encrypted to test the key against, a real run refuses and writes nothing', async () => {
  // Otherwise running Step 4 before Step 3 under the wrong key encrypts everything
  // with it, and the next run "proves" that key by decrypting its own values.
  const tables = { transactions: [{ id: 'a', user_id: 'u1', amount: 5, amount_enc: null }] };
  const fake = makeFake(tables);
  await assert.rejects(
    () => runBackfillStrict({ supabase: fake, jobs: JOB, log: silent }),
    /REFUSING TO START — nothing is encrypted yet/,
  );
  assert.equal(fake.writes.length, 0);
  assert.equal(tables.transactions[0].amount_enc, null);
});

test('one value that decrypts is enough for a real run to go ahead', async () => {
  const job = JOBS.find((j) => j.table === 'transactions');
  const gappy = { ...fullyEncryptedRow(job), id: 'r2', description_enc: null };
  const tables = { transactions: [fullyEncryptedRow(job), gappy] };
  const totals = await runBackfillStrict({ supabase: makeFake(tables), jobs: [job], log: silent });
  assert.equal(totals.encrypted, 1);
  assert.equal(decryptField('transactions.description', 'u1', gappy.description_enc), gappy.description);
});

test('the wrong key is caught even when the only ciphertext is in the LAST table', async () => {
  const tx = JOBS.find((j) => j.table === 'transactions');
  const cats = JOBS.find((j) => j.table === 'categories');
  const untouched = { id: 'a', user_id: 'u1', amount: 5, amount_enc: null, original_amount: null, original_amount_enc: null, description: null, description_enc: null, merchant_prefix_hmacs: null };
  const fake = makeFake({ transactions: [untouched], categories: [fullyEncryptedRow(cats)] });
  await underWrongKey(() => assert.rejects(
    () => runBackfillStrict({ supabase: fake, jobs: [tx, cats], log: silent }),
    /REFUSING TO START — 1 encrypted value/,
  ));
  assert.equal(fake.writes.length, 0);
});

test('ciphertext beside a cleared plaintext counts as evidence against the wrong key', async () => {
  const job = JOBS.find((j) => j.table === 'transactions');
  const row = { ...fullyEncryptedRow(job), amount_enc: null, description_enc: null, merchant_prefix_hmacs: null, original_amount: null };
  const fake = makeFake({ transactions: [row] });
  await underWrongKey(() => assert.rejects(
    () => runBackfillStrict({ supabase: fake, jobs: [job], log: silent }),
    /REFUSING TO START — 1 encrypted value/,
  ));
  assert.equal(fake.writes.length, 0);
});

test('an unset or malformed key reports itself, not "will not decrypt"', async () => {
  // The runbook's rollback card tells Alex to look for these exact words.
  const job = JOBS.find((j) => j.table === 'transactions');
  const fake = makeFake({ transactions: [fullyEncryptedRow(job)] });
  const productionKey = process.env.DATA_ENCRYPTION_KEY;
  try {
    delete process.env.DATA_ENCRYPTION_KEY;
    await assert.rejects(() => runBackfill({ supabase: fake, jobs: [job], log: silent }), /DATA_ENCRYPTION_KEY is not set/);
    process.env.DATA_ENCRYPTION_KEY = 'not valid base64!';
    await assert.rejects(() => runBackfill({ supabase: fake, jobs: [job], log: silent }), /canonical base64/);
  } finally {
    process.env.DATA_ENCRYPTION_KEY = productionKey;
  }
  assert.equal(fake.writes.length, 0);
});

test('the refusal lists at most 20 rows and hides a merchant_key primary key', async () => {
  // subscription_overrides' primary key IS user data: a merchant name, or a key
  // embedding an amount bucket. This message may get pasted into a chat.
  const job = JOBS.find((j) => j.table === 'subscription_overrides');
  const rows = Array.from({ length: 25 }, (_, i) => {
    const row = fullyEncryptedRow(job);
    row.merchant_key = `dr jane ${String(i).padStart(2, '0')}`;
    row.merchant_key_enc = encryptField('subscription_overrides.merchant_key', 'u1', row.merchant_key);
    row.display_name_enc = encryptField('subscription_overrides.display_name', 'u2', row.display_name); // damaged
    return row;
  });
  const fake = makeFake({ subscription_overrides: rows });
  await assert.rejects(
    () => runBackfill({ supabase: fake, jobs: [job], dryRun: true, log: silent }),
    (e) => {
      assert.ok(!e.message.includes('dr jane'), 'the merchant must not be printed');
      assert.match(e.message, /user_id=u1 merchant_key=sha256:[0-9a-f]{12} display_name_enc/);
      assert.equal(e.message.split('\n').filter((l) => l.includes('display_name_enc')).length, 20);
      assert.match(e.message, /and 5 more/);
      return true;
    },
  );
});

test('a blind index that does not land correctly is caught and rolled back', async () => {
  // A run can now write ONLY a blind index (name_hmac). Its database check had
  // no test: delete it and nothing went red.
  const job = JOBS.find((j) => j.table === 'categories');
  const row = fullyEncryptedRow(job);
  row.name_hmac = null;
  await assert.rejects(
    () => runBackfill({ supabase: makeFake({ categories: [row] }, { corruptColumn: 'name_hmac' }), jobs: [job], log: silent }),
    /VERIFY FAILED \(blind index does not match/,
  );
  assert.equal(row.name_hmac, null, 'rolled back, so the re-run sees it again');
});
