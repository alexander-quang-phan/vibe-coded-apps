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
const { encryptField, blindIndexMany } = await import('../lib/crypto.js');
const { merchantPrefixes } = await import('../lib/merchant.js');
const IDX = 'transactions.merchant_prefix_hmacs';

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
/** A service_role-shaped JWT, so preflight passes and tests exercise the real path. */
const SERVICE_JWT = `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64')}.y`;
const ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT,
  DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
};

function makeFake(rows, faults = {}) {
  let countCalls = 0;
  let readCalls = 0;
  return {
    from() {
      const q = {
        _head: false, _isNull: [], _notNull: [], _order: [], _limit: null, _range: null,
        select(_cols, opts) { q._head = Boolean(opts && opts.head); return q; },
        is(col, val) { if (val === null) q._isNull.push(col); return q; },
        not(col, _op, val) { if (val === null) q._notNull.push(col); return q; },
        order(col) { q._order.push(col); return q; },
        limit(n) { q._limit = n; return q; },
        gt() { return q; },
        range(a, b) { q._range = [a, b]; return q; },
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
          readCalls += 1;
          if (faults.onRead) faults.onRead(readCalls, rows);
          if (faults.hideLastFromReads) out = out.slice(0, -1);
          // Order by every column the caller asked for — what Postgres does.
          const key = (r) => q._order.map((c) => String(r[c])).join('\u0000');
          out = [...out].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
          if (q._range) {
            const [from, to] = q._range;
            // Optionally simulate a server-side row cap: return FEWER rows than
            // asked for even when more exist. Correct paging must still cover
            // the whole table.
            const end = faults.serverCap ? Math.min(to + 1, from + faults.serverCap) : to + 1;
            out = out.slice(from, end);
          }
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
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent, env: ENV });
  assert.equal(r.pass, true);
  assert.equal(r.checked, 2);
});

test('FAIL when plaintext exists with no ciphertext — the rows 013 would destroy', async () => {
  const rows = [{ id: 'a', user_id: U, amount: 12.5, amount_enc: null }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent, env: ENV });
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
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent, env: ENV });
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
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent, env: ENV });
  assert.equal(r.pass, false);
  assert.equal(r.stale, 1);
});

test('FAIL on ciphertext that will not decrypt, without echoing the value', async () => {
  const rows = [{ id: 'a', user_id: U, amount: 10, amount_enc: 'v2:zz:zz:zz' }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent, env: ENV });
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /will not decrypt/);
  assert.ok(!r.failures.join(' ').includes('zz:zz:zz'), 'must not echo stored bytes');
});

test('an absent count FAILS CLOSED instead of reading as zero rows at risk', async () => {
  // `count ?? 0` meant a query that came back without a count authorised the drop.
  const rows = [{ id: 'a', user_id: U, amount: 10, amount_enc: enc(10) }];
  await assert.rejects(
    () => verifyEncryption({ supabase: makeFake(rows, { nullCount: true }), jobs: JOB, log: silent, env: ENV }),
    /Refusing to treat an absent count as zero/,
  );
});

test('FAIL when the 03:00 cron inserts a plaintext row before the read pass', async () => {
  // lib/runRecurrences.js INSERTs transactions and cannot write _enc. Whatever
  // the timing, the gate must not pass. Here the insert lands before the rows are
  // read, so it is caught as what it is: a row 019 would destroy.
  const rows = [{ id: 'a', user_id: U, amount: 10, amount_enc: enc(10) }];
  const fake = makeFake(rows, {
    onCount: (n) => {
      if (n === 2) rows.push({ id: 'b', user_id: U, amount: 99, amount_enc: null });
    },
  });
  const r = await verifyEncryption({ supabase: fake, jobs: JOB, log: silent, env: ENV });
  assert.equal(r.pass, false);
  assert.ok(
    r.failures.some((f) => /NO ciphertext/.test(f)),
    'a plaintext row with no ciphertext must be caught by the row pass itself, ' +
      'not left to a count taken at a different instant',
  );
});

test('FAIL when the cron inserts a plaintext row BETWEEN the two read passes', async () => {
  // The same cron, later by a second. Now the first pass never saw the row, so
  // only the digest comparison can tell the database moved.
  const rows = [{ id: 'a', user_id: U, amount: 10, amount_enc: enc(10) }];
  let done = false;
  const fake = makeFake(rows, {
    onRead: (n) => {
      if (n === 3 && !done) { done = true; rows.push({ id: 'b', user_id: U, amount: 99, amount_enc: null }); }
    },
  });
  const r = await verifyEncryption({ supabase: fake, jobs: JOB, log: silent, env: ENV });
  assert.equal(r.pass, false);
  assert.deepEqual(r.drifted, ['transactions']);
});

test('a sampled run can never authorise the drop', async () => {
  const rows = [{ id: 'a', user_id: U, amount: 12.5, amount_enc: enc(12.5) }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, sample: 1, log: silent, env: ENV });
  assert.equal(r.complete, false);
  assert.equal(r.pass, false, 'INCOMPLETE is not PASS');
});

test('every row is checked across pagination, so a stale row on page 2 is still caught', async () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({
    id: String(i).padStart(4, '0'), user_id: U, amount: i, amount_enc: enc(i),
  }));
  rows[550].amount_enc = enc(999999); // stale, well past the old 50-row sample
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent, env: ENV });
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

// --- blind indexes -----------------------------------------------------------

test('CRITICAL: FAIL on a blind index that does not match its plaintext', async () => {
  // A wrong index throws nowhere. Merchant memory silently stops suggesting, and
  // after 013 the plaintext is gone so it can never be recomputed. This gate is
  // the last moment it is checkable at all.
  const job = [{
    table: 'transactions',
    pk: ['id'],
    fields: [{ table: 'transactions', column: 'description', enc: 'description_enc', kind: 'text' }],
    blind: [{ table: 'transactions', column: 'merchant_prefix_hmacs', from: 'description', normalise: 'merchantPrefixes', multi: true }],
  }];
  const good = {
    id: 'a', user_id: U, description: 'Tesco Express',
    description_enc: encryptField('transactions.description', U, 'Tesco Express'),
    merchant_prefix_hmacs: blindIndexMany(IDX, U, merchantPrefixes('Tesco Express')),
  };
  const ok = await verifyEncryption({ supabase: makeFake([good]), jobs: job, log: silent, env: ENV });
  assert.equal(ok.pass, true);

  // Same row, but the index is for a different merchant — e.g. the description
  // was edited through a route that updated the ciphertext and forgot the index.
  const bad = { ...good, merchant_prefix_hmacs: blindIndexMany(IDX, U, merchantPrefixes('Boots')) };
  const r = await verifyEncryption({ supabase: makeFake([bad]), jobs: job, log: silent, env: ENV });
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /blind index does not match/);
});

test('FAIL when a description is encrypted but its index was never written', async () => {
  const job = [{
    table: 'transactions',
    pk: ['id'],
    fields: [{ table: 'transactions', column: 'description', enc: 'description_enc', kind: 'text' }],
    blind: [{ table: 'transactions', column: 'merchant_prefix_hmacs', from: 'description', normalise: 'merchantPrefixes', multi: true }],
  }];
  const rows = [{
    id: 'a', user_id: U, description: 'Boots',
    description_enc: encryptField('transactions.description', U, 'Boots'),
    merchant_prefix_hmacs: null,
  }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: job, log: silent, env: ENV });
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /blind index does not match/);
});

// --- regressions for the two false-PASS states Codex reproduced --------------

test('REGRESSION (Codex): 501 rows under a composite PK are all verified, not 500', async () => {
  // The gate keyset-paged on pkOf(job)[0] alone. On subscription_overrides that
  // is `user_id`, so after the first page `.gt('user_id', <same user>)` matched
  // nothing, the scan stopped at 500, and row 501 was never looked at — while
  // the gate printed PASS and would have authorised dropping it.
  const job = [{
    table: 'subscription_overrides',
    pk: ['user_id', 'merchant_key'],
    fields: [{ table: 'subscription_overrides', column: 'display_name', enc: 'display_name_enc', kind: 'text' }],
    blind: [],
  }];
  const rows = Array.from({ length: 501 }, (_, i) => ({
    user_id: U,
    merchant_key: `m${String(i).padStart(4, '0')}`,
    display_name: `Name ${i}`,
    display_name_enc: encryptField('subscription_overrides.display_name', U, `Name ${i}`),
  }));
  // The LAST row by key order is stale. If paging stops early, it is invisible.
  rows[500].display_name_enc = encryptField('subscription_overrides.display_name', U, 'STALE');

  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: job, log: silent, env: ENV });
  assert.equal(r.checked, 501, 'every row must be verified, not one page of them');
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => /STALE/.test(f)), 'the 501st row must be caught');
});

test('REGRESSION (Codex): a server row cap cannot cause rows to be skipped', async () => {
  // If the server returns fewer rows than requested, advancing the window by the
  // number REQUESTED would step over the remainder. Advance by what arrived.
  const job = [{
    table: 'transactions', pk: ['id'],
    fields: [{ table: 'transactions', column: 'amount', enc: 'amount_enc', kind: 'amount' }],
    blind: [],
  }];
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    id: String(i).padStart(5, '0'), user_id: U, amount: i + 1,
    amount_enc: encryptField('transactions.amount', U, String(i + 1)),
  }));
  const r = await verifyEncryption({ supabase: makeFake(rows, { serverCap: 137 }), jobs: job, log: silent, env: ENV });
  assert.equal(r.checked, 1200);
  assert.equal(r.pass, true);
});

test('REGRESSION: rows-checked must equal the exact table count, whatever the paging does', async () => {
  // The general invariant behind both regressions above: any paging bug at all,
  // present or future, fails the gate rather than silently leaving rows unseen.
  const job = [{
    table: 'transactions', pk: ['id'],
    fields: [{ table: 'transactions', column: 'amount', enc: 'amount_enc', kind: 'amount' }],
    blind: [],
  }];
  const rows = [
    { id: 'a', user_id: U, amount: 1, amount_enc: encryptField('transactions.amount', U, '1') },
    { id: 'b', user_id: U, amount: 2, amount_enc: encryptField('transactions.amount', U, '2') },
  ];
  // Reads never return the last row, while COUNT still reports it — exactly the
  // shape of a paging bug, and of the composite-cursor bug Codex found.
  const r = await verifyEncryption({
    supabase: makeFake(rows, { hideLastFromReads: true }), jobs: job, log: silent, env: ENV,
  });
  assert.equal(r.pass, false);
  assert.ok(r.skipped.length > 0, 'unaccounted rows must fail the gate');
});

test('REGRESSION (Codex): a value-only edit after the read pass is detected as drift', async () => {
  // The drift check re-ran COUNTS. Editing an amount from 250 to 25 leaves every
  // count identical, so it reported "no drift" while the ciphertext went stale.
  // A digest over each row's keys, plaintext, ciphertext and indexes sees it.
  // Here the concurrent write is CORRECT (both columns updated together), so
  // nothing is stale — only the digest can tell the database moved.
  const job = [{
    table: 'transactions', pk: ['id'],
    fields: [{ table: 'transactions', column: 'amount', enc: 'amount_enc', kind: 'amount' }],
    blind: [],
  }];
  const rows = [{ id: 'a', user_id: U, amount: 250, amount_enc: encryptField('transactions.amount', U, '250') }];
  let done = false;
  const fake = makeFake(rows, {
    onRead: (n) => {
      // Reads 1-2 are the first verify pass; the re-read pass follows.
      if (n === 3 && !done) {
        done = true;
        rows[0].amount = 25;
        rows[0].amount_enc = encryptField('transactions.amount', U, '25');
      }
    },
  });
  const r = await verifyEncryption({ supabase: fake, jobs: job, log: silent, env: ENV });
  assert.equal(r.failures.length, 0, 'the write was correct — nothing should be stale');
  assert.deepEqual(r.drifted, ['transactions'], 'but the database moved, so the PASS must be void');
  assert.equal(r.pass, false);
});

// --- preflight: what exactly is being authorised ----------------------------

test('the gate refuses to speak for a database it is reading through the anon key', async () => {
  // Through the anon key, RLS hides other users' rows and every count reads as a
  // comforting zero — a PASS describing almost none of the database.
  const anon = `x.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64')}.y`;
  const rows = [{ id: 'a', user_id: U, amount: 1, amount_enc: encryptField('transactions.amount', U, '1') }];
  const r = await verifyEncryption({
    supabase: makeFake(rows), jobs: JOB, log: silent,
    env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: anon },
  });
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => /service_role/.test(f)));
});

test('the gate reports which database and which key, without printing the key', async () => {
  const rows = [{ id: 'a', user_id: U, amount: 1, amount_enc: encryptField('transactions.amount', U, '1') }];
  const lines = [];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: (m) => lines.push(m), env: ENV });
  const out = lines.join('\n');
  assert.match(out, /test\.supabase\.co/);
  assert.match(out, /service_role/);
  assert.match(out, /fingerprint [0-9a-f]{12}/);
  assert.ok(!out.includes(ENV.DATA_ENCRYPTION_KEY), 'the key itself must never be printed');
  assert.equal(r.target.host, 'test.supabase.co');
});

test('a missing encryption key fails the gate rather than verifying nothing', async () => {
  const rows = [{ id: 'a', user_id: U, amount: 1, amount_enc: encryptField('transactions.amount', U, '1') }];
  const r = await verifyEncryption({
    supabase: makeFake(rows), jobs: JOB, log: silent,
    env: { ...ENV, DATA_ENCRYPTION_KEY: undefined },
  });
  assert.equal(r.pass, false);
});

test('an amount that decrypts to a non-number fails the gate, not just the app', async () => {
  // Registered `kind` is now enforced HERE. Otherwise the gate certifies a value
  // that becomes 0 or NaN in the app the moment the plaintext is dropped.
  const rows = [{ id: 'a', user_id: U, amount: 'abc', amount_enc: encryptField('transactions.amount', U, 'abc') }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent, env: ENV });
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => /not as a valid amount/.test(f)));
});

test('a two-decimal amount is NOT reported as a mismatch', async () => {
  // Comparing a kind-converted value would turn a stored "12.50" into 12.5 and
  // mismatch every two-decimal amount in the database — a gate that can never pass.
  const rows = [{ id: 'a', user_id: U, amount: '12.50', amount_enc: encryptField('transactions.amount', U, '12.50') }];
  const r = await verifyEncryption({ supabase: makeFake(rows), jobs: JOB, log: silent, env: ENV });
  assert.equal(r.failures.length, 0);
  assert.equal(r.pass, true);
});
