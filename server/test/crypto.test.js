import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptField, decryptField, encryptAmount, decryptAmount } from '../lib/crypto.js';

// Test fixture key only — never a real key, and it stays inside this file.
process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';

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
  const stored = encryptField(USER_A, 'Coffee with Em');
  assert.notEqual(stored, 'Coffee with Em');
  assert.ok(stored.startsWith('v1:'));
  assert.equal(decryptField(USER_A, stored), 'Coffee with Em');
});

test('round-trips amounts as numbers', () => {
  assert.equal(decryptAmount(USER_A, encryptAmount(USER_A, 123.45)), 123.45);
});

test('ciphertext is bound to the user', () => {
  const stored = encryptField(USER_A, 'secret');
  assert.throws(() => decryptField(USER_B, stored));
});

test('tampered ciphertext throws', () => {
  const stored = encryptField(USER_A, 'secret');
  const parts = stored.split(':');
  parts[3] = Buffer.from('tampered!').toString('base64');
  assert.throws(() => decryptField(USER_A, parts.join(':')));
});

test('unique IVs — same plaintext, different ciphertext', () => {
  assert.notEqual(encryptField(USER_A, 'same'), encryptField(USER_A, 'same'));
});

// --- key handling -----------------------------------------------------------

test('missing DATA_ENCRYPTION_KEY throws', () => {
  withKey(undefined, () => {
    assert.throws(() => encryptField(USER_A, 'x'), /DATA_ENCRYPTION_KEY is not set/);
  });
});

test('DATA_ENCRYPTION_KEY that is not 32 bytes throws', () => {
  withKey(Buffer.alloc(16, 7).toString('base64'), () => {
    assert.throws(() => encryptField(USER_A, 'x'), /must be 32 bytes base64/);
  });
});

test('DATA_ENCRYPTION_KEY that is not canonical base64 throws', () => {
  // Buffer.from silently drops characters outside the base64 alphabet, so
  // without a shape check a mistyped key can still yield 32 bytes and become a
  // silently different key. Whitespace is the realistic version of this.
  withKey(` ${Buffer.alloc(32, 7).toString('base64')}\n`, () => {
    assert.throws(() => encryptField(USER_A, 'x'), /canonical base64/);
  });
});

// --- malformed / legacy stored values ---------------------------------------

test('bare plaintext left in the column throws rather than being returned', () => {
  assert.throws(() => decryptField(USER_A, 'Coffee'), /Unknown ciphertext version/);
});

test('empty stored string throws', () => {
  assert.throws(() => decryptField(USER_A, ''), /Unknown ciphertext version/);
});

test('truncated envelope "v1:" throws', () => {
  assert.throws(() => decryptField(USER_A, 'v1:'), /expected 4 colon-separated parts/);
});

test('unknown future version throws', () => {
  const parts = encryptField(USER_A, 'secret').split(':');
  parts[0] = 'v2';
  assert.throws(() => decryptField(USER_A, parts.join(':')), /Unknown ciphertext version: v2/);
});

test('null and undefined pass through as null', () => {
  assert.equal(encryptField(USER_A, null), null);
  assert.equal(encryptField(USER_A, undefined), null);
  assert.equal(decryptField(USER_A, null), null);
  assert.equal(decryptField(USER_A, undefined), null);
});

// --- auth tag integrity (the write-capable-attacker threat model) ------------

test('tampered auth tag throws', () => {
  const parts = encryptField(USER_A, 'secret').split(':');
  const tag = Buffer.from(parts[2], 'base64');
  tag[0] ^= 0x01; // same length, one bit different
  parts[2] = tag.toString('base64');
  assert.throws(() => decryptField(USER_A, parts.join(':')));
});

test('truncated auth tag is rejected, not accepted', () => {
  // Node accepts a 4-byte GCM tag with only a deprecation warning, which drops
  // forgery cost from 2^128 to 2^32. A short tag must be a hard error.
  const parts = encryptField(USER_A, 'secret').split(':');
  parts[2] = Buffer.from(parts[2], 'base64').subarray(0, 4).toString('base64');
  assert.throws(() => decryptField(USER_A, parts.join(':')), /auth tag must be 16 bytes, got 4/);
});

test('mangled IV length is rejected', () => {
  const parts = encryptField(USER_A, 'secret').split(':');
  parts[1] = Buffer.from(parts[1], 'base64').subarray(0, 8).toString('base64');
  assert.throws(() => decryptField(USER_A, parts.join(':')), /IV must be 12 bytes, got 8/);
});

// --- amounts must never fail open -------------------------------------------

test('decryptAmount throws on an empty decrypted value instead of returning 0', () => {
  const stored = encryptField(USER_A, '');
  assert.throws(() => decryptAmount(USER_A, stored), /not a finite number/);
});

test('decryptAmount throws on a non-numeric decrypted value instead of returning NaN', () => {
  const stored = encryptField(USER_A, 'abc');
  assert.throws(() => decryptAmount(USER_A, stored), /not a finite number/);
});

test('encryptAmount refuses empty string and NaN, but keeps null/undefined and zero', () => {
  assert.throws(() => encryptAmount(USER_A, ''), /non-finite amount/);
  assert.throws(() => encryptAmount(USER_A, NaN), /non-finite amount/);
  assert.throws(() => encryptAmount(USER_A, Infinity), /non-finite amount/);
  assert.equal(encryptAmount(USER_A, null), null);
  assert.equal(encryptAmount(USER_A, undefined), null);
  assert.equal(decryptAmount(USER_A, encryptAmount(USER_A, 0)), 0); // 0 is a real amount
  assert.equal(decryptAmount(USER_A, null), null);
});
