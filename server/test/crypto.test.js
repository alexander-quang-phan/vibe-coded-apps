import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptField, decryptField, encryptAmount, decryptAmount } from '../lib/crypto.js';

process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';

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
