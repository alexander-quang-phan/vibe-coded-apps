import { test } from 'node:test';
import assert from 'node:assert/strict';

// The backfill imports crypto.js, which needs a key. Set one BEFORE importing.
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { runBackfill, parseArgs, JOBS, PAGE_SIZE } = await import('../scripts/encrypt-backfill.mjs');
const { decryptField } = await import('../lib/crypto.js');
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
        _mode: null, _filters: [], _isNull: null, _gt: null, _limit: null, _patch: null, _range: null,
        select() { q._mode = 'select'; return q; },
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
          return Promise.resolve({ data: out.map((r) => ({ ...r })), error: null }).then(resolve, reject);
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
