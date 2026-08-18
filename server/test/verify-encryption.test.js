/**
 * First tests this gate has ever had.
 *
 * It is the single authorisation for an IRREVERSIBLE drop of five people's
 * financial data, and until 2026-08-18 it had none. The audit's critical finding
 * was that it could return PASS on a database it would then destroy: it asked
 * only "is the plaintext present while the ciphertext is NULL?", so a row where
 * both were present and DISAGREED — the product of any missed UPDATE path, or of
 * any edit between the backfill and the drop — was invisible to it.
 *
 * Every test below is written so that it FAILS against that old behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { verifyEncryption, parseArgs } = await import('../scripts/verify-encryption.mjs');
const { encryptField } = await import('../lib/crypto.js');

const U = '00000000-0000-4000-8000-000000000001';
const enc = (v, field = 'transactions.amount') => encryptField(field, U, String(v));
const JOB = [{
  table: 'transactions',
  pk: ['id'],
  fields: [{ table: 'transactions', column: 'amount', enc: 'amount_enc', kind: 'amount' }],
}];
const silent = () => {};

/**
 * Fake PostgREST. Models exactly what the gate uses: head counts with
 * is/not-is-null filters, and keyset-paginated selects.
 * `faults.nullCount` makes a count come back absent — the fail-open case.
 * `faults.onCount` fires after the first counting pass, to simulate the app
 * writing while the gate runs.
 */
function makeFake(rows, faults = {}) {
  let countCalls = 0;
  return {
    from() {
      const q = {
        _head: false, _isNull: [], _notNull: [], _order: null, _limit: null, _gt: null,
        select(_cols, opts) { q._head = Boolean(opts && opts.head); return q; },
        is(col, val) { if (val === null) q._isNull.push(col); return q; },
        not(col, _op, val) { if (val === null) q._notNull.push(col); return q; },
        order(col) { q._order = col; return q; },
        limit(n) { q._limit = n; return q; },
        gt(col, v) { q._gt = [col, v]; return q; },
        then(resolve, reject) {
          let out = rows.filter(
            (r) => q._isNull.every((c) => r[c] == null) && q._notNull.every((c) => r[c] != null),
          );
          if (q._head) {
            countCalls += 1;
            if (faults.onCount) faults.onCount(countCalls, rows);
            const count = faults.nullCount ? null : out.length;
            return Promise.resolve({ count, error: null }).then(resolve, reject);
          }
          if (q._gt) out = out.filter((r) => r[q._gt[0]] > q._gt[1]);
          out = [...out].sort((a, b) => (a.id > b.id ? 1 : -1));
          if (q._limit) out = out.slice(0, q._limit);
          return Promise.resolve({ data: out.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

test('PASS on a fully and correctly encrypted table', async () => {
  const rows = [
    { id: 'a', user_id: U, amount: 12.5, amount_enc: enc(12.5) },
    { id: 'b', user_id: U, amount: null, amount_enc: null },
  ];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent });
  assert.equal(r.pass, true);
  assert.equal(r.checked, 2);
});

test('FAIL when plaintext exists with no ciphertext — the rows 013 would destroy', async () => {
  const rows = [{ id: 'a', user_id: U, amount: 12.5, amount_enc: null }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent });
  assert.equal(r.pass, false);
  assert.equal(r.missing, 1);
});

test('CRITICAL REGRESSION: FAIL on stale ciphertext when both columns are present but disagree', async () => {
  // The exact scenario the audit could not refute: backfill runs Monday, user
  // corrects 250 -> 25 on Tuesday through a route that writes only `amount`.
  // The old gate counted 0 (ciphertext is not NULL) and its 50-row unordered
  // sample would likely never fetch this row. It printed PASS, and 013 made
  // £250 permanent with no plaintext left to recover from.
  const rows = [{ id: 'a', user_id: U, amount: 25, amount_enc: enc(250) }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent });
  assert.equal(r.pass, false, 'a stale ciphertext must never pass the gate');
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /STALE/);
});

test('CRITICAL REGRESSION: FAIL when a cleared value still has ciphertext', async () => {
  // The deterministic half of the same hole: user sets monthly_limit = 800, is
  // backfilled, then clears it. plaintext NULL + ciphertext present. The old
  // gate skipped the comparison entirely whenever plaintext was NULL, so this
  // passed even when sampled. After 013 the cleared limit silently returns.
  const rows = [{ id: 'a', user_id: U, amount: null, amount_enc: enc(800) }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent });
  assert.equal(r.pass, false);
  assert.equal(r.stale, 1);
});

test('FAIL on ciphertext that will not decrypt, without echoing the value', async () => {
  const rows = [{ id: 'a', user_id: U, amount: 10, amount_enc: 'v2:zz:zz:zz' }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent });
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /will not decrypt/);
  assert.ok(!r.failures.join(' ').includes('zz:zz:zz'), 'must not echo stored bytes');
});

test('an absent count FAILS CLOSED instead of reading as zero rows at risk', async () => {
  // `count ?? 0` meant a query that came back without a count authorised the drop.
  const rows = [{ id: 'a', user_id: U, amount: 10, amount_enc: enc(10) }];
  await assert.rejects(
    () => verifyEncryption({ supabase: makeFake(rows, { nullCount: true }), jobs: JOB, log: silent }),
    /Refusing to treat an absent count as zero/,
  );
});

test('FAIL when the database changes while the gate is running', async () => {
  // The 03:00 recurrences cron inserting a plaintext row mid-gate. A PASS that
  // describes a database that no longer exists is not a PASS.
  const rows = [{ id: 'a', user_id: U, amount: 10, amount_enc: enc(10) }];
  const fake = makeFake(rows, {
    onCount: (n) => {
      if (n === 2) rows.push({ id: 'b', user_id: U, amount: 99, amount_enc: null });
    },
  });
  const r = await verifyEncryption({ supabase: fake, jobs: JOB, log: silent });
  assert.equal(r.pass, false);
  assert.ok(r.drifted.length > 0, 'concurrent writes must void the PASS');
});

test('a sampled run can never authorise the drop', async () => {
  const rows = [{ id: 'a', user_id: U, amount: 12.5, amount_enc: enc(12.5) }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, sample: 1, log: silent });
  assert.equal(r.complete, false);
  assert.equal(r.pass, false, 'INCOMPLETE is not PASS');
});

test('every row is checked across pagination, so a stale row on page 2 is still caught', async () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({
    id: String(i).padStart(4, '0'), user_id: U, amount: i, amount_enc: enc(i),
  }));
  rows[550].amount_enc = enc(999999); // stale, well past the old 50-row sample
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent });
  assert.equal(r.checked, 600);
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /STALE/);
});

test('parseArgs is strict about flags', () => {
  assert.deepEqual(parseArgs([]), { sample: null });
  assert.deepEqual(parseArgs(['--sample', '200']), { sample: 200 });
  // The old parser used argv.indexOf('--sample'), so this matched nothing and
  // silently ran at the default depth while looking like a deliberate deep check.
  assert.deepEqual(parseArgs(['--sample=200']), { sample: 200 });
  assert.throws(() => parseArgs(['--sample', '0']), /positive whole number/);
  assert.throws(() => parseArgs(['--sample', 'abc']), /positive whole number/);
  assert.throws(() => parseArgs(['--dry-run']), /Unknown option/);
});

test('the gate derives its scope from the registry, not from the backfill it audits', async () => {
  const { JOBS } = await import('../scripts/verify-encryption.mjs');
  const { ENCRYPTED_FIELDS, fieldKey } = await import('../lib/encryptedFields.js');
  const fromGate = JOBS.flatMap((j) => j.fields.map((f) => fieldKey(j.table, f.column))).sort();
  assert.deepEqual(fromGate, ENCRYPTED_FIELDS.map((f) => fieldKey(f.table, f.column)).sort());
});
