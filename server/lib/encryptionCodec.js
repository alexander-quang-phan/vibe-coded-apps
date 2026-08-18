/**
 * Phase 9.5 Part A — the codec at the query boundary.
 *
 * THE IDEA, and why the sweep is shaped this way. Trim has ~96 database call
 * sites and roughly twice as many places that do arithmetic on the values they
 * return (`Number(b.amount_limit)`, `spent / effectiveLimit`, and so on). Porting
 * the arithmetic would be a rewrite of the whole app. Porting the BOUNDARY is
 * three functions:
 *
 *   selectFor()    rewrites the column list a query asks for
 *   decodeRows()   hands the route back a plaintext-shaped row, whatever is stored
 *   encodeWrite()  turns a plaintext-shaped patch into the columns to write
 *
 * Between those two points nothing changes. `routes/budgets.js` still reads
 * `b.amount_limit` and still multiplies it.
 *
 * PHASES (lib/encryptionPhase.js). `off` is the default and is byte-for-byte
 * today's behaviour — the same columns selected, the same columns written — so
 * this can ship and be exercised in production before any key exists.
 *
 *   off   plaintext only.                    Nothing is encrypted anywhere.
 *   dual  plaintext AND ciphertext.          Migrations 012/018/018a applied.
 *   enc   ciphertext only.                   Migration 019 has dropped plaintext.
 *
 * Everything here derives from `lib/encryptedFields.js`. There are no per-table
 * lists in this file, because hand-maintained lists are what produced both of the
 * data-destroying defects this phase had to fix.
 *
 * READS during `dual` deliberately prefer the PLAINTEXT column. It is the column
 * the database still constrains, it needs no key, and if the two ever disagree the
 * plaintext is the one the user last saw. The gate is what turns a disagreement
 * into a loud failure; the app should not be quietly picking the other one.
 */
import { encryptRegistered, decryptRegistered } from './crypto.js';
import {
  ENCRYPTED_FIELDS, BLIND_INDEXES, blindIndexesFor, fieldKey,
} from './encryptedFields.js';
import { blindValueFor } from './blindIndex.js';
import { CURRENT_PHASE, writesPlaintext, writesCiphertext } from './encryptionPhase.js';

/** Encrypted fields for one table, keyed by plaintext column name. */
const byTable = new Map();
for (const f of ENCRYPTED_FIELDS) {
  if (!byTable.has(f.table)) byTable.set(f.table, new Map());
  byTable.get(f.table).set(f.column, f);
}

export const encryptedColumnsFor = (table) => byTable.get(table) ?? new Map();

/** Is this table touched by encryption at all? Most helpers no-op when not. */
export const isEncryptedTable = (table) => byTable.has(table);

/**
 * Rewrite a PostgREST column list for the current phase.
 *
 * Accepts the string routes already pass (`'id, amount_limit, period'`) and
 * returns the string to pass instead. Columns that are not encrypted are left
 * exactly where they were, so a diff of the sweep stays readable.
 *
 *   off   'id, amount_limit, period'
 *   dual  'id, amount_limit, amount_limit_enc, period'
 *   enc   'id, amount_limit_enc, period'
 *
 * `user_id` is added only when a ciphertext column is actually being read, because
 * the decryption key is derived from it. At `off` nothing is decoded, so nothing
 * is added and the query is exactly the one the route always sent.
 */
export function selectFor(table, columns, phase = CURRENT_PHASE) {
  const fields = encryptedColumnsFor(table);
  if (fields.size === 0) return columns;

  const wanted = String(columns).split(',').map((c) => c.trim()).filter(Boolean);
  const out = [];
  let touched = false;

  for (const col of wanted) {
    const f = fields.get(col);
    if (!f) { out.push(col); continue; }
    touched = true;
    if (writesPlaintext(phase)) out.push(col);
    if (writesCiphertext(phase)) out.push(f.enc);
  }

  // ONLY when a ciphertext column is being read. At phase `off` nothing needs
  // decoding, and adding a column the caller did not ask for would break the
  // guarantee that `off` is byte-for-byte today's behaviour.
  if (touched && writesCiphertext(phase) && !out.includes('user_id')) out.push('user_id');
  return [...new Set(out)].join(', ');
}

/**
 * Present a stored row the way the route expects it: plaintext values under their
 * plaintext names, whatever is actually in the database.
 *
 * Returns a NEW object; the caller's row is not mutated. A value that cannot be
 * decrypted THROWS rather than silently becoming null — a budget that quietly
 * reads as zero is worse than an error, and lib/crypto.js is careful never to put
 * user data in the message.
 */
export function decodeRow(table, userId, row, phase = CURRENT_PHASE) {
  const fields = encryptedColumnsFor(table);
  if (fields.size === 0 || !row) return row;

  const out = { ...row };
  for (const [column, f] of fields) {
    // Prefer the plaintext while it exists: it is what the database still
    // constrains, and during `dual` it is the value the user last saw.
    if (writesPlaintext(phase) && out[column] !== undefined) continue;
    if (out[f.enc] === undefined) continue; // not selected; nothing to decode
    out[column] = out[f.enc] === null
      ? null
      : decryptRegistered(fieldKey(table, column), userId ?? row.user_id, out[f.enc]);
  }
  return out;
}

export function decodeRows(table, userId, rows, phase = CURRENT_PHASE) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => decodeRow(table, userId, r, phase));
}

/**
 * Turn a plaintext-shaped insert/update into the columns to write.
 *
 * Only columns PRESENT in the patch are touched, so a partial update stays
 * partial — `{ amount_limit: 50 }` must not blank a description.
 *
 * Blind indexes are recomputed whenever their source column is in the patch. That
 * is the whole reason merchant memory cannot silently rot: an UPDATE that changes
 * a description and forgets its index is impossible to write through here.
 */
export function encodeWrite(table, userId, patch, phase = CURRENT_PHASE) {
  const fields = encryptedColumnsFor(table);
  if (fields.size === 0 || !patch) return patch;
  if (!userId) throw new Error(`encodeWrite(${table}) called without a userId`);

  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    const f = fields.get(key);
    if (!f) { out[key] = value; continue; }
    if (writesPlaintext(phase)) out[key] = value;
    if (writesCiphertext(phase)) {
      out[f.enc] = value === null || value === undefined
        ? null
        : encryptRegistered(fieldKey(table, key), userId, String(value));
    }
  }

  if (writesCiphertext(phase)) {
    for (const b of blindIndexesFor(table)) {
      // `from` is the plaintext column the index is derived from. Recompute only
      // when this write actually touches it.
      if (!(b.from in patch)) continue;
      out[b.column] = blindValueFor(table, b, { ...patch, user_id: userId });
    }
  }
  return out;
}

/**
 * Decode a row and hand back ONLY the columns the caller asked for.
 *
 * This exists because routes return database rows straight to the client
 * (`res.json({ budget: data })`). Once `selectFor` starts adding `amount_limit_enc`
 * and `user_id` to the query, returning the row wholesale would ship ciphertext —
 * and another user-identifying column — to the browser. Nobody would notice,
 * because the app reads the fields it always read and ignores the rest.
 *
 * Pass the SAME column string the route wanted before the sweep. Anything the
 * codec added for its own use is dropped on the way out.
 */
export function presentRow(table, userId, row, columns, phase = CURRENT_PHASE) {
  if (!row) return row;
  const decoded = decodeRow(table, userId, row, phase);
  const keep = String(columns).split(',').map((c) => c.trim()).filter(Boolean);
  const out = {};
  for (const k of keep) if (k in decoded) out[k] = decoded[k];
  return out;
}

export function presentRows(table, userId, rows, columns, phase = CURRENT_PHASE) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => presentRow(table, userId, r, columns, phase));
}

/**
 * The columns a write path must NOT set by hand. Exported so a test can assert
 * that no route writes an `_enc` or `_hmac` column directly — every one of them
 * has to come from encodeWrite, or the two halves drift.
 */
export const MANAGED_COLUMNS = Object.freeze([
  ...ENCRYPTED_FIELDS.map((f) => `${f.table}.${f.enc}`),
  ...BLIND_INDEXES.map((b) => `${b.table}.${b.column}`),
]);
