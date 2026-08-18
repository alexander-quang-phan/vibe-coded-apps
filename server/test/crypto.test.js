import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptField, decryptField, encryptAmount, decryptAmount, blindIndex } from '../lib/crypto.js';

// Test fixture key only — never a real key, and it stays inside this file.
process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';

// Real registry entries — crypto.js rejects anything not in lib/encryptedFields.js.
const TX_AMOUNT = 'transactions.amount';
const TX_ORIGINAL = 'transactions.original_amount';
const GOAL_TARGET = 'savings_goals.target_amount';
const GOAL_CURRENT = 'savings_goals.current_amount';
const BUDGET_LIMIT = 'budgets.amount_limit';
const ASK_CONTENT = 'ask_messages.content';

/** Swap DATA_ENCRYPTION_KEY for one assertion, then always put it back. */
function withKey(value, fn) {
  const saved = process.env.DATA_ENCRYPTION_KEY;
  try {
    if (value === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = saved;
  }
}

test('round-trips text', () => {
  const stored = encryptField(ASK_CONTENT, USER_A, 'Coffee with Em');
  assert.notEqual(stored, 'Coffee with Em');
  assert.ok(stored.startsWith('v2:'));
  assert.equal(decryptField(ASK_CONTENT, USER_A, stored), 'Coffee with Em');
});

test('round-trips amounts as numbers', () => {
  assert.equal(decryptAmount(TX_AMOUNT, USER_A, encryptAmount(TX_AMOUNT, USER_A, 123.45)), 123.45);
});

test('ciphertext is bound to the user', () => {
  const stored = encryptField(TX_AMOUNT, USER_A, 'secret');
  assert.throws(() => decryptField(TX_AMOUNT, USER_B, stored));
});

test('tampered ciphertext throws', () => {
  const stored = encryptField(TX_AMOUNT, USER_A, 'secret');
  const parts = stored.split(':');
  parts[3] = Buffer.from('tampered!').toString('base64');
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, parts.join(':')));
});

test('unique IVs — same plaintext, different ciphertext', () => {
  assert.notEqual(encryptField(TX_AMOUNT, USER_A, 'same'), encryptField(TX_AMOUNT, USER_A, 'same'));
});

// --- AAD: a value only decrypts where it was written -------------------------
// Regression tests for the 2026-08-18 audit. Under v1 (user binding only) both
// of these SUCCEEDED, which is how a savings goal's target could be replayed
// over its current balance, or a budget limit over a transaction amount.

test('a ciphertext moved to another COLUMN of the same table does not decrypt', () => {
  const target = encryptField(GOAL_TARGET, USER_A, '5000');
  assert.equal(decryptField(GOAL_TARGET, USER_A, target), '5000');
  assert.throws(() => decryptField(GOAL_CURRENT, USER_A, target));
});

test('a ciphertext moved to another TABLE does not decrypt', () => {
  const limit = encryptField(BUDGET_LIMIT, USER_A, '1200');
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, limit));
});

test('the two transactions money columns are not interchangeable', () => {
  // The whole point of encrypting original_amount: amount = original_amount * fx_rate,
  // so the pair must not be swappable either.
  const original = encryptField(TX_ORIGINAL, USER_A, '45.00');
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, original));
});

test('an unregistered field name is a loud error, not a silent one-off AAD', () => {
  assert.throws(() => encryptField('transaction.amount', USER_A, '1'), /Unknown encrypted field/);
  assert.throws(() => decryptField('transactions.amonut', USER_A, 'v2:a:b:c'), /Unknown encrypted field/);
});

test('encrypting without a userId throws rather than deriving a key from undefined', () => {
  assert.throws(() => encryptField(TX_AMOUNT, undefined, '10'), /without a userId/);
  assert.throws(() => encryptField(TX_AMOUNT, null, '10'), /without a userId/);
});

// --- key handling -----------------------------------------------------------

test('missing DATA_ENCRYPTION_KEY throws', () => {
  withKey(undefined, () => {
    assert.throws(() => encryptField(TX_AMOUNT, USER_A, 'x'), /DATA_ENCRYPTION_KEY is not set/);
  });
});

test('DATA_ENCRYPTION_KEY that is not 32 bytes throws', () => {
  withKey(Buffer.alloc(16, 7).toString('base64'), () => {
    assert.throws(() => encryptField(TX_AMOUNT, USER_A, 'x'), /must be 32 bytes base64/);
  });
});

test('DATA_ENCRYPTION_KEY that is not canonical base64 throws', () => {
  // Buffer.from silently drops characters outside the base64 alphabet, so
  // without a shape check a mistyped key can still yield 32 bytes and become a
  // silently different key. Whitespace is the realistic version of this.
  withKey(` ${Buffer.alloc(32, 7).toString('base64')}\n`, () => {
    assert.throws(() => encryptField(TX_AMOUNT, USER_A, 'x'), /canonical base64/);
  });
});

test('the key is re-read per call, so one process can hold two generations', () => {
  // This is what makes key rotation possible WITHOUT a key id in the envelope:
  // a rotation script decrypts under the old key and re-encrypts under the new
  // one in a single process. Caching masterKey() at module load would break it.
  const oldKey = Buffer.alloc(32, 1).toString('base64');
  const newKey = Buffer.alloc(32, 2).toString('base64');
  let underOld;
  withKey(oldKey, () => { underOld = encryptField(TX_AMOUNT, USER_A, '42.50'); });
  withKey(newKey, () => { assert.throws(() => decryptField(TX_AMOUNT, USER_A, underOld)); });
  withKey(oldKey, () => { assert.equal(decryptField(TX_AMOUNT, USER_A, underOld), '42.50'); });
});

// --- malformed / legacy stored values ---------------------------------------

test('bare plaintext left in the column throws rather than being returned', () => {
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, 'Coffee'), /Unknown ciphertext version/);
});

test('a v1 envelope is refused rather than decrypted under the new rules', () => {
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, 'v1:aaaa:bbbb:cccc'), /Unknown ciphertext version/);
});

test('empty stored string throws', () => {
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, ''), /Unknown ciphertext version/);
});

test('truncated envelope "v2:" throws', () => {
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, 'v2:'), /expected 4 colon-separated parts/);
});

test('null and undefined pass through as null', () => {
  assert.equal(encryptField(TX_AMOUNT, USER_A, null), null);
  assert.equal(encryptField(TX_AMOUNT, USER_A, undefined), null);
  assert.equal(decryptField(TX_AMOUNT, USER_A, null), null);
  assert.equal(decryptField(TX_AMOUNT, USER_A, undefined), null);
});

// --- errors must never echo user data ---------------------------------------
// server/index.js:120 logs err.message for every error reaching the handler, so
// an echoed value would copy plaintext into Vercel's logs — a second,
// unencrypted store of exactly what this module exists to hide.

test('the version error does not echo the stored value', () => {
  const secret = 'I spent 4200 on IVF treatment at Care Fertility';
  try {
    decryptField(ASK_CONTENT, USER_A, secret);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes(secret), `message leaked the value: ${err.message}`);
    assert.ok(!err.message.includes('4200'), `message leaked an amount: ${err.message}`);
    assert.match(err.message, /value withheld/);
  }
});

test('malformed-envelope errors leak only lengths, never bytes', () => {
  const secret = 'Dr Okafor session';
  const stored = `v2:${Buffer.from(secret).toString('base64')}:x:y`;
  try {
    decryptField(ASK_CONTENT, USER_A, stored);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes(secret));
    assert.ok(!err.message.includes(Buffer.from(secret).toString('base64')));
  }
});

// --- auth tag integrity (the write-capable-attacker threat model) ------------

test('tampered auth tag throws', () => {
  const parts = encryptField(TX_AMOUNT, USER_A, 'secret').split(':');
  const tag = Buffer.from(parts[2], 'base64');
  tag[0] ^= 0x01; // same length, one bit different
  parts[2] = tag.toString('base64');
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, parts.join(':')));
});

test('truncated auth tag is rejected, not accepted', () => {
  // Node accepts a 4-byte GCM tag with only a deprecation warning, which drops
  // forgery cost from 2^128 to 2^32. A short tag must be a hard error.
  const parts = encryptField(TX_AMOUNT, USER_A, 'secret').split(':');
  parts[2] = Buffer.from(parts[2], 'base64').subarray(0, 4).toString('base64');
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, parts.join(':')), /auth tag must be 16 bytes, got 4/);
});

test('mangled IV length is rejected', () => {
  const parts = encryptField(TX_AMOUNT, USER_A, 'secret').split(':');
  parts[1] = Buffer.from(parts[1], 'base64').subarray(0, 8).toString('base64');
  assert.throws(() => decryptField(TX_AMOUNT, USER_A, parts.join(':')), /IV must be 12 bytes, got 8/);
});

// --- amounts must never fail open -------------------------------------------

test('decryptAmount throws on an empty decrypted value instead of returning 0', () => {
  const stored = encryptField(TX_AMOUNT, USER_A, '');
  assert.throws(() => decryptAmount(TX_AMOUNT, USER_A, stored), /not a finite number/);
});

test('decryptAmount throws on a non-numeric decrypted value instead of returning NaN', () => {
  const stored = encryptField(TX_AMOUNT, USER_A, 'abc');
  assert.throws(() => decryptAmount(TX_AMOUNT, USER_A, stored), /not a finite number/);
});

test('encryptAmount refuses empty string and NaN, but keeps null/undefined and zero', () => {
  assert.throws(() => encryptAmount(TX_AMOUNT, USER_A, ''), /non-finite amount/);
  assert.throws(() => encryptAmount(TX_AMOUNT, USER_A, NaN), /non-finite amount/);
  assert.throws(() => encryptAmount(TX_AMOUNT, USER_A, Infinity), /non-finite amount/);
  assert.equal(encryptAmount(TX_AMOUNT, USER_A, null), null);
  assert.equal(encryptAmount(TX_AMOUNT, USER_A, undefined), null);
  assert.equal(decryptAmount(TX_AMOUNT, USER_A, encryptAmount(TX_AMOUNT, USER_A, 0)), 0); // 0 is a real amount
  assert.equal(decryptAmount(TX_AMOUNT, USER_A, null), null);
});

// --- blind index -------------------------------------------------------------
// Merchant memory has to find "other transactions from this merchant" IN THE
// DATABASE, and you cannot ILIKE a ciphertext. These tests pin the trade-offs
// that choice makes, so nobody has to rediscover them from the code.

const MERCHANT_IDX = 'transactions.merchant_hmac';

test('a blind index is deterministic — that is the whole point, and the whole cost', () => {
  assert.equal(blindIndex(MERCHANT_IDX, USER_A, 'tesco'), blindIndex(MERCHANT_IDX, USER_A, 'tesco'));
});

test('a blind index does not contain the value it indexes', () => {
  const idx = blindIndex(MERCHANT_IDX, USER_A, 'sainsburys local');
  assert.ok(!idx.toLowerCase().includes('sainsbury'));
  assert.notEqual(idx, 'sainsburys local');
});

test('the same merchant under two users produces different indexes', () => {
  // Without per-user index keys, one leaked backup would let someone correlate
  // spending across every user at once — "these four people all shop here".
  assert.notEqual(blindIndex(MERCHANT_IDX, USER_A, 'netflix'), blindIndex(MERCHANT_IDX, USER_B, 'netflix'));
});

test('indexes from different columns are not comparable', () => {
  // The field name is mixed into the hash, so you cannot line up one column's
  // index against another's to learn that two values are equal.
  assert.notEqual(
    blindIndex('transactions.merchant_hmac', USER_A, 'netflix'),
    blindIndex('transactions.merchant_hmac_1', USER_A, 'netflix'),
  );
});

test('an empty or missing value has no index rather than a shared one', () => {
  // If blank hashed to a real value, every blank-description row would group
  // together into one visible bucket.
  assert.equal(blindIndex(MERCHANT_IDX, USER_A, null), null);
  assert.equal(blindIndex(MERCHANT_IDX, USER_A, undefined), null);
  assert.equal(blindIndex(MERCHANT_IDX, USER_A, ''), null);
});

test('an unregistered blind index is a loud error', () => {
  assert.throws(() => blindIndex('transactions.merchant_hash', USER_A, 'x'), /Unknown blind index/);
});

test('the index key is derived separately from the encryption key', () => {
  // Same HKDF master, different info label ('blind:' vs 'user:'). If they were
  // the same key, the HMAC and the ciphertext would share key material.
  const idx = blindIndex(MERCHANT_IDX, USER_A, 'tesco');
  const ct = encryptField('transactions.description', USER_A, 'tesco');
  assert.notEqual(idx, ct);
  assert.ok(!ct.includes(idx));
});
