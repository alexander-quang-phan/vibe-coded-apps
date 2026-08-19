/**
 * The query-boundary codec — Phase 9.5 Part A.
 *
 * The property that matters most is the FIRST test: at `ENCRYPTION_PHASE=off`,
 * which is the default and what production runs today, the codec must be a no-op.
 * The whole point of shaping the sweep this way is that it can ship, and be
 * exercised by real users, before any key exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const {
  selectFor, decodeRow, decodeRows, encodeWrite, encryptedColumnsFor, isEncryptedTable,
  MANAGED_COLUMNS,
} = await import('../lib/encryptionCodec.js');
const { decryptField, decryptRegistered, blindIndex, blindIndexMany } = await import('../lib/crypto.js');
const { merchantPrefixes } = await import('../lib/merchant.js');
const { ENCRYPTED_FIELDS } = await import('../lib/encryptedFields.js');

const U = '00000000-0000-4000-8000-000000000001';

// --- phase off: nothing may change ------------------------------------------

test('CRITICAL: at phase off the codec is a no-op in both directions', () => {
  // This is what makes Part A shippable before a key exists. If this test ever
  // fails, the sweep has started changing production behaviour.
  const cols = 'id, category_id, amount_limit, period, created_at';
  assert.equal(selectFor('budgets', cols, 'off'), cols);

  const stored = { id: 'b1', user_id: U, amount_limit: 50, period: 'monthly' };
  assert.deepEqual(decodeRow('budgets', U, stored, 'off'), stored);

  const patch = { amount_limit: 50, period: 'weekly' };
  assert.deepEqual(encodeWrite('budgets', U, patch, 'off'), patch);
});

test('a table with nothing encrypted is untouched in every phase', () => {
  assert.equal(isEncryptedTable('special_group_members'), false);
  for (const phase of ['off', 'dual', 'enc']) {
    assert.equal(selectFor('special_group_members', 'id, name', phase), 'id, name');
    const row = { id: 'x', name: 'keep' };
    assert.deepEqual(decodeRow('special_group_members', U, row, phase), row);
    assert.deepEqual(encodeWrite('special_group_members', U, { name: 'keep' }, phase), { name: 'keep' });
  }
});

// --- selectFor ---------------------------------------------------------------

test('dual selects both columns; enc selects only the ciphertext', () => {
  const cols = 'id, category_id, amount_limit, period';
  assert.equal(
    selectFor('budgets', cols, 'dual'),
    'id, category_id, amount_limit, amount_limit_enc, period, user_id',
  );
  assert.equal(
    selectFor('budgets', cols, 'enc'),
    'id, category_id, amount_limit_enc, period, user_id',
  );
});

test('user_id is added whenever an encrypted column is selected', () => {
  // Without it the row cannot be decoded: the key is HKDF(master, user:<id>).
  assert.match(selectFor('transactions', 'id, amount', 'enc'), /user_id/);
  // ...and not added when nothing on the table is encrypted in this list.
  assert.equal(selectFor('transactions', 'id, date, type', 'enc'), 'id, date, type');
});

test('selectFor does not duplicate a user_id the caller already asked for', () => {
  const out = selectFor('transactions', 'id, user_id, amount', 'enc');
  assert.equal(out.split(',').filter((c) => c.trim() === 'user_id').length, 1);
});

test('columns the registry does not know are passed through untouched', () => {
  assert.equal(selectFor('budgets', 'id, period, created_at', 'enc'), 'id, period, created_at');
});

// --- decode ------------------------------------------------------------------

test('enc phase decodes ciphertext back under the plaintext name', () => {
  const patch = encodeWrite('budgets', U, { amount_limit: 50 }, 'enc');
  assert.equal(patch.amount_limit, undefined, 'the plaintext column no longer exists');
  const decoded = decodeRow('budgets', U, { id: 'b1', user_id: U, ...patch }, 'enc');
  assert.equal(decoded.amount_limit, 50, 'the route still reads b.amount_limit');
});

test('dual phase PREFERS the plaintext, which is what the user last saw', () => {
  // If the two ever disagree, the plaintext is the column the database still
  // constrains and the value the user last saw. The gate is what makes a
  // disagreement loud; the app must not quietly pick the other one.
  const row = {
    id: 'b1', user_id: U,
    amount_limit: 50,
    amount_limit_enc: encodeWrite('budgets', U, { amount_limit: 999 }, 'enc').amount_limit_enc,
  };
  assert.equal(decodeRow('budgets', U, row, 'dual').amount_limit, 50);
});

test('a NULL ciphertext decodes to null, not to a thrown error', () => {
  const row = { id: 'u1', user_id: U, monthly_limit_enc: null };
  assert.equal(decodeRow('user_stats', U, row, 'enc').monthly_limit, null);
});

test('an unreadable ciphertext THROWS rather than reading as zero', () => {
  // A budget that silently becomes 0 is worse than an error, and the error
  // never contains user data.
  const row = { id: 'b1', user_id: U, amount_limit_enc: 'v2:zz:zz:zz' };
  assert.throws(() => decodeRow('budgets', U, row, 'enc'));
});

test('decode takes the user id from the row when none is passed', () => {
  const patch = encodeWrite('budgets', U, { amount_limit: 12.5 }, 'enc');
  const decoded = decodeRow('budgets', null, { id: 'b1', user_id: U, ...patch }, 'enc');
  assert.equal(decoded.amount_limit, 12.5);
});

test('decodeRows maps a list and leaves a non-list alone', () => {
  const enc = (v) => encodeWrite('budgets', U, { amount_limit: v }, 'enc').amount_limit_enc;
  const rows = [
    { id: 'a', user_id: U, amount_limit_enc: enc(1) },
    { id: 'b', user_id: U, amount_limit_enc: enc(2) },
  ];
  assert.deepEqual(decodeRows('budgets', U, rows, 'enc').map((r) => r.amount_limit), [1, 2]);
  assert.equal(decodeRows('budgets', U, null, 'enc'), null);
});

test('a column that was not selected is not invented', () => {
  const row = { id: 'b1', user_id: U, period: 'monthly' };
  assert.deepEqual(decodeRow('budgets', U, row, 'enc'), row);
});

test('decode does not mutate the row it was given', () => {
  const patch = encodeWrite('budgets', U, { amount_limit: 7 }, 'enc');
  const row = { id: 'b1', user_id: U, ...patch };
  const copy = { ...row };
  decodeRow('budgets', U, row, 'enc');
  assert.deepEqual(row, copy);
});

// --- encode ------------------------------------------------------------------

test('a two-decimal amount is STORED exactly, and read back as a number', () => {
  // The gate learned this the hard way: the stored bytes must be "12.50", or its
  // string comparison mismatches every two-decimal amount in the database. The
  // ROUTE, by contrast, wants a number — every call site already does
  // `Number(b.amount_limit)` — so decoding an `amount` yields 12.5.
  const patch = encodeWrite('transactions', U, { amount: '12.50' }, 'enc');
  assert.equal(decryptField('transactions.amount', U, patch.amount_enc), '12.50', 'stored bytes');
  assert.equal(decryptRegistered('transactions.amount', U, patch.amount_enc), 12.5, 'as the app sees it');

  const decoded = decodeRow('transactions', U, { id: 't1', user_id: U, ...patch }, 'enc');
  assert.equal(decoded.amount, 12.5);
  assert.equal(Number(decoded.amount).toFixed(2), '12.50', 'and it still formats correctly');
});

test('a partial update stays partial', () => {
  // `{ amount_limit: 50 }` must not blank anything else on the row.
  const patch = encodeWrite('transactions', U, { amount: 10 }, 'dual');
  assert.deepEqual(Object.keys(patch).sort(), ['amount', 'amount_enc']);
});

test('null clears both halves rather than encrypting the word "null"', () => {
  const patch = encodeWrite('user_stats', U, { monthly_limit: null }, 'dual');
  assert.equal(patch.monthly_limit, null);
  assert.equal(patch.monthly_limit_enc, null);
});

test('CRITICAL: a write that touches a description also rewrites its blind index', () => {
  // An UPDATE that changes the description and forgets the index is what makes
  // merchant memory rot silently — and after 019 the plaintext is gone, so it can
  // never be recomputed. Going through encodeWrite makes that impossible.
  const patch = encodeWrite('transactions', U, { description: 'Tesco Express 1234' }, 'enc');
  assert.deepEqual(
    patch.merchant_prefix_hmacs,
    blindIndexMany('transactions.merchant_prefix_hmacs', U, merchantPrefixes('Tesco Express 1234')),
  );
  assert.equal(decryptRegistered('transactions.description', U, patch.description_enc), 'Tesco Express 1234');
});

test('a write that does NOT touch the description leaves the index alone', () => {
  const patch = encodeWrite('transactions', U, { amount: 10 }, 'enc');
  assert.ok(!('merchant_prefix_hmacs' in patch), 'an amount edit must not rewrite the merchant index');
});

test('the category blind index is written from the name', () => {
  const patch = encodeWrite('categories', U, { name: 'Therapy' }, 'enc');
  assert.equal(patch.name_hmac, blindIndex('categories.name_hmac', U, 'Therapy'));
  assert.equal(decryptRegistered('categories.name', U, patch.name_enc), 'Therapy');
});

test('phase off writes NO index, because the columns do not exist yet', () => {
  const patch = encodeWrite('transactions', U, { description: 'Tesco' }, 'off');
  assert.deepEqual(patch, { description: 'Tesco' });
});

test('encodeWrite refuses without a user id', () => {
  // Every key is derived from it; without one the value is unreadable forever.
  assert.throws(() => encodeWrite('budgets', null, { amount_limit: 1 }, 'enc'), /without a userId/);
});

test('an amount that is not a number is refused at the boundary', () => {
  // `kind: 'amount'` is enforced by encryptRegistered, so junk cannot be stored
  // and then become NaN in the app once the plaintext is gone.
  assert.throws(() => encodeWrite('budgets', U, { amount_limit: 'abc' }, 'enc'));
});

// --- the registry is the only list -------------------------------------------

test('the codec knows every registered field, and invents none', () => {
  for (const f of ENCRYPTED_FIELDS) {
    assert.ok(
      encryptedColumnsFor(f.table).has(f.column),
      `${f.table}.${f.column} is registered but the codec does not handle it`,
    );
  }
  assert.equal(MANAGED_COLUMNS.length, ENCRYPTED_FIELDS.length + 3, 'fields + 3 blind indexes');
});

// --- presentRow: nothing the codec added may reach the client ----------------

test('CRITICAL: presentRow never leaks ciphertext or user_id to the client', async () => {
  const { presentRow, presentRows } = await import('../lib/encryptionCodec.js');
  const WANT = 'id, category_id, amount_limit, period';

  const stored = {
    id: 'b1', category_id: 'c1', period: 'monthly',
    user_id: U, // added by selectFor so the row could be decoded
    ...encodeWrite('budgets', U, { amount_limit: 50 }, 'enc'),
  };
  const out = presentRow('budgets', U, stored, WANT, 'enc');

  assert.deepEqual(Object.keys(out).sort(), ['amount_limit', 'category_id', 'id', 'period']);
  assert.equal(out.amount_limit, 50);
  assert.ok(!('amount_limit_enc' in out), 'ciphertext must never be serialised to the browser');
  assert.ok(!('user_id' in out), 'nor a column the route never asked for');

  const list = presentRows('budgets', U, [stored, stored], WANT, 'enc');
  assert.equal(list.length, 2);
  assert.ok(!('amount_limit_enc' in list[0]));
});

test('presentRow at phase off returns exactly what the route always returned', async () => {
  const { presentRow } = await import('../lib/encryptionCodec.js');
  const WANT = 'id, category_id, amount_limit, period';
  const stored = { id: 'b1', category_id: 'c1', amount_limit: 50, period: 'monthly' };
  assert.deepEqual(presentRow('budgets', U, stored, WANT, 'off'), stored);
});

test('presentRow omits a requested column the database did not return', async () => {
  const { presentRow } = await import('../lib/encryptionCodec.js');
  const out = presentRow('budgets', U, { id: 'b1' }, 'id, period', 'off');
  assert.deepEqual(out, { id: 'b1' });
});
