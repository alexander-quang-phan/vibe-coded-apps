/**
 * Phase 9.5 — at-rest encryption of users' financial data.
 * AES-256-GCM; per-user key derived from DATA_ENCRYPTION_KEY via HKDF so a
 * value copied into another user's row will not decrypt. Stored format:
 * v1:<iv b64>:<auth tag b64>:<ciphertext b64>  (in text columns).
 * Losing DATA_ENCRYPTION_KEY = losing every user's data. See SECURITY.md.
 *
 * Fail-closed rules (this module guards financial data — never guess):
 * - Anything that is not a well-formed v1 envelope throws. We never return a
 *   partially-trusted value, and we never fall back to treating stored bytes
 *   as plaintext.
 * - The GCM auth tag must be exactly 16 bytes. Node will otherwise accept a
 *   truncated tag (with only a deprecation warning), which drops forgery cost
 *   from 2^128 to 2^32 against a write-capable attacker — precisely the threat
 *   this encryption exists to stop.
 * - Amounts must decrypt to a finite number. `Number('')` is 0 and
 *   `Number('abc')` is NaN, and neither throws, so a mangled amount column
 *   would otherwise become a silent 0-value transaction or poison every total.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const HKDF_SALT = 'trim-data-v1';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16; // full-length GCM tag; anything shorter is rejected

/** Canonical (non-url) base64, optional padding. Rejects whitespace/newlines. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function masterKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) throw new Error('DATA_ENCRYPTION_KEY is not set');
  // Buffer.from(..., 'base64') silently DISCARDS characters outside the base64
  // alphabet, so a mistyped or whitespace-padded key can still decode to 32
  // bytes and become a silently different key — every row written under it
  // would be unreadable by the intended key. Validate the string shape first.
  if (!BASE64_RE.test(raw)) {
    throw new Error(
      'DATA_ENCRYPTION_KEY must be canonical base64 (A-Z a-z 0-9 + / =) with no whitespace, quotes or newlines',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`DATA_ENCRYPTION_KEY must be ${KEY_BYTES} bytes base64 (decoded to ${key.length})`);
  }
  // Round-trip catches anything the regex let through (e.g. bad padding), so
  // the key we use is exactly the key the operator backed up.
  if (key.toString('base64') !== raw) {
    throw new Error('DATA_ENCRYPTION_KEY is not canonical base64 — re-copy it from your backup');
  }
  return key;
}

function userKey(userId) {
  return Buffer.from(hkdfSync('sha256', masterKey(), HKDF_SALT, `user:${userId}`, KEY_BYTES));
}

export function encryptField(userId, plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', userKey(userId), iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptField(userId, stored) {
  if (stored === null || stored === undefined) return null;
  const parts = String(stored).split(':');
  // Version first: gives the clearest error for bare plaintext left behind by a
  // half-finished backfill, and for a future v2 envelope read by old code.
  if (parts[0] !== VERSION) throw new Error(`Unknown ciphertext version: ${parts[0]}`);
  if (parts.length !== 4) {
    throw new Error(`Malformed ciphertext: expected 4 colon-separated parts, got ${parts.length}`);
  }
  const [, ivB64, tagB64, ctB64] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new Error(`Malformed ciphertext: IV must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  // Assert BEFORE setAuthTag. `authTagLength` below makes Node enforce this too,
  // but the explicit check is what documents the invariant and survives a
  // future refactor that drops the option.
  const tag = Buffer.from(tagB64, 'base64');
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Malformed ciphertext: auth tag must be ${TAG_BYTES} bytes, got ${tag.length}`);
  }

  const decipher = createDecipheriv('aes-256-gcm', userKey(userId), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptAmount(userId, amount) {
  if (amount === null || amount === undefined) return null;
  // Reject '' and NaN rather than encrypting them: `Number('')` is 0, so an
  // empty amount field would otherwise round-trip into a real 0-value row.
  const text = String(amount).trim();
  if (text === '' || !Number.isFinite(Number(text))) {
    throw new Error(`encryptAmount: refusing to encrypt a non-finite amount (type ${typeof amount})`);
  }
  return encryptField(userId, String(amount));
}

export function decryptAmount(userId, stored) {
  const s = decryptField(userId, stored);
  if (s === null) return null;
  // Fail closed. Note `Number('')` is 0, which PASSES Number.isFinite — so a
  // blank must be rejected explicitly or an emptied amount column silently
  // becomes a real 0-value transaction. `Number('abc')` is NaN, which the
  // isFinite check catches.
  const n = s.trim() === '' ? NaN : Number(s);
  if (!Number.isFinite(n)) throw new Error('decryptAmount: decrypted value is not a finite number');
  return n;
}
