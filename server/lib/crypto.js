/**
 * Phase 9.5 — at-rest encryption of users' financial data.
 * AES-256-GCM; per-user key derived from DATA_ENCRYPTION_KEY via HKDF so a
 * value copied into another user's row will not decrypt. Stored format:
 * v1:<iv b64>:<auth tag b64>:<ciphertext b64>  (in text columns).
 * Losing DATA_ENCRYPTION_KEY = losing every user's data. See SECURITY.md.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const HKDF_SALT = 'trim-data-v1';

function masterKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) throw new Error('DATA_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes base64');
  return key;
}

function userKey(userId) {
  return Buffer.from(hkdfSync('sha256', masterKey(), HKDF_SALT, `user:${userId}`, 32));
}

export function encryptField(userId, plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', userKey(userId), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptField(userId, stored) {
  if (stored === null || stored === undefined) return null;
  const [version, ivB64, tagB64, ctB64] = String(stored).split(':');
  if (version !== VERSION) throw new Error(`Unknown ciphertext version: ${version}`);
  const decipher = createDecipheriv('aes-256-gcm', userKey(userId), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptAmount(userId, amount) {
  return amount === null || amount === undefined ? null : encryptField(userId, String(amount));
}

export function decryptAmount(userId, stored) {
  const s = decryptField(userId, stored);
  return s === null ? null : Number(s);
}
