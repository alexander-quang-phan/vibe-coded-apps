/**
 * Phase 9.5 — at-rest encryption of users' financial data.
 *
 * AES-256-GCM. Two independent bindings, so a stored value only decrypts in the
 * exact place it was written:
 *   - WHOSE it is:  the key is HKDF(master, info: `user:<id>`), so a value moved
 *                   into another user's row will not decrypt.
 *   - WHERE it sits: `table.column` is passed to GCM as additional authenticated
 *                   data, so a value moved to another column or table will not
 *                   decrypt either.
 *
 * Stored format: v2:<iv b64>:<auth tag b64>:<ciphertext b64>  (in text columns).
 * Losing DATA_ENCRYPTION_KEY = losing every user's data. See SECURITY.md.
 *
 * Why v2, and why now (2026-08-18): v1 authenticated only the user. An audit
 * reproduced a ciphertext written for `savings_goals.target_amount` decrypting
 * cleanly as `current_amount`, and a `budgets.amount_limit` value decrypting as
 * `transactions.amount`. That is not the headline threat — anyone who can write
 * to the database can already overwrite a plaintext numeric today — but AAD is
 * nearly free to add and can ONLY be added before the first row is encrypted:
 * afterwards it means re-encrypting every row under a new envelope. Nothing has
 * ever been encrypted (migration 012 is unapplied, no route imports this module),
 * so this is the last cost-free moment to get the envelope right.
 *
 * NOT bound: the row id. Every table's `id` is `default gen_random_uuid()`, so
 * the server does not know it until after the INSERT returns. Binding to it would
 * mean generating uuids server-side on every insert path — a wider change than
 * the threat justifies. Consequence, stated plainly: a ciphertext can still be
 * copied between two rows of the SAME user and SAME column. That is strictly less
 * freedom than an attacker with database write access already has.
 *
 * Fail-closed rules (this module guards financial data — never guess):
 * - Anything that is not a well-formed v2 envelope throws. We never return a
 *   partially-trusted value, and we never fall back to treating stored bytes
 *   as plaintext.
 * - The GCM auth tag must be exactly 16 bytes. Node will otherwise accept a
 *   truncated tag (with only a deprecation warning), which drops forgery cost
 *   from 2^128 to 2^32 against a write-capable attacker — precisely the threat
 *   this encryption exists to stop.
 * - Amounts must decrypt to a finite number. `Number('')` is 0 and
 *   `Number('abc')` is NaN, and neither throws, so a mangled amount column
 *   would otherwise become a silent 0-value transaction or poison every total.
 * - No error message ever contains a stored or decrypted value. Errors reach
 *   server/index.js:120, which logs `err.message` into Vercel's logs — echoing
 *   the value there would copy the plaintext this module exists to hide into a
 *   second, unencrypted store.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { requireField } from './encryptedFields.js';

const VERSION = 'v2';
const HKDF_SALT = 'trim-data-v1'; // unchanged: this salts the KEY, not the envelope
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
  // Deliberately NOT cached at module load: re-reading env on every call is what
  // lets one process hold two key generations at once, which is how a rotation
  // script reads old rows and writes new ones without a key id in the envelope.
  return key;
}

function userKey(userId) {
  if (!userId) throw new Error('encrypt/decrypt called without a userId');
  return Buffer.from(hkdfSync('sha256', masterKey(), HKDF_SALT, `user:${userId}`, KEY_BYTES));
}

/**
 * The GCM additional authenticated data. Not secret and not stored — it is
 * re-derived on read from where the value was found, so a value that has moved
 * fails authentication. Validated against the registry so a typo'd field name is
 * a loud error, not a value nobody can ever decrypt.
 */
function aad(field) {
  requireField(field);
  return Buffer.from(field, 'utf8');
}

export function encryptField(field, userId, plaintext) {
  requireField(field); // before the null check, so a typo cannot pass silently
  if (plaintext === null || plaintext === undefined) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', userKey(userId), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(field));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptField(field, userId, stored) {
  // Validate the field name BEFORE anything else. A typo must be a loud
  // "unknown field" error whatever the stored value looks like — otherwise a
  // mistyped column reports "malformed ciphertext" and sends the reader hunting
  // for data corruption that does not exist.
  requireField(field);
  if (stored === null || stored === undefined) return null;
  const parts = String(stored).split(':');
  // Version first: gives the clearest error for bare plaintext left behind by a
  // half-finished backfill, and for a future v3 envelope read by old code.
  // The version itself is NEVER echoed — for bare plaintext, parts[0] IS the
  // user's data (a whole 8000-char Ask Trim message, in the worst case).
  if (parts[0] !== VERSION) {
    throw new Error(`Unknown ciphertext version in ${field} (expected ${VERSION}; value withheld)`);
  }
  if (parts.length !== 4) {
    throw new Error(`Malformed ciphertext in ${field}: expected 4 colon-separated parts, got ${parts.length}`);
  }
  const [, ivB64, tagB64, ctB64] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new Error(`Malformed ciphertext in ${field}: IV must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  // Assert BEFORE setAuthTag. `authTagLength` below makes Node enforce this too,
  // but the explicit check is what documents the invariant and survives a
  // future refactor that drops the option.
  const tag = Buffer.from(tagB64, 'base64');
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Malformed ciphertext in ${field}: auth tag must be ${TAG_BYTES} bytes, got ${tag.length}`);
  }

  const decipher = createDecipheriv('aes-256-gcm', userKey(userId), iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(field));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptAmount(field, userId, amount) {
  requireField(field);
  if (amount === null || amount === undefined) return null;
  // Reject '' and NaN rather than encrypting them: `Number('')` is 0, so an
  // empty amount field would otherwise round-trip into a real 0-value row.
  const text = String(amount).trim();
  if (text === '' || !Number.isFinite(Number(text))) {
    throw new Error(`encryptAmount(${field}): refusing to encrypt a non-finite amount (type ${typeof amount})`);
  }
  return encryptField(field, userId, String(amount));
}

export function decryptAmount(field, userId, stored) {
  const s = decryptField(field, userId, stored);
  if (s === null) return null;
  // Fail closed. Note `Number('')` is 0, which PASSES Number.isFinite — so a
  // blank must be rejected explicitly or an emptied amount column silently
  // becomes a real 0-value transaction. `Number('abc')` is NaN, which the
  // isFinite check catches.
  const n = s.trim() === '' ? NaN : Number(s);
  if (!Number.isFinite(n)) throw new Error(`decryptAmount(${field}): decrypted value is not a finite number`);
  return n;
}
