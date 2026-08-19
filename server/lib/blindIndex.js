/**
 * Blind-index values — the canonical implementation.
 *
 * These lived in `scripts/encrypt-backfill.mjs`, which meant the migration-019
 * gate imported them from the script it audits. That is the same shape as the
 * defect the 2026-08-18 audit found in the JOBS list, and now the route codec
 * needs them too: a library must not depend on a maintenance script.
 *
 * `lib/encryptedFields.js` names a normaliser as a STRING (`'merchantPrefixes'`,
 * `'identity'`) so the registry stays data. This module is where those names are
 * resolved to functions — one place, so the write path, the backfill, the gate
 * and the read path cannot drift. A blind index whose two sides disagree by one
 * character returns nothing, forever, with no error.
 */
import { blindIndex, blindIndexMany } from './crypto.js';
import { fieldKey } from './encryptedFields.js';
import { normaliseMerchant, normaliseMerchantFirstWord, merchantPrefixes } from './merchant.js';

/** Must match the read path exactly — see lib/merchant.js. */
export const NORMALISERS = {
  merchant: normaliseMerchant,
  merchantFirstWord: normaliseMerchantFirstWord,
  merchantPrefixes,
  identity: (v) => (v === null || v === undefined ? null : String(v)),
};

/** The blind-index value a row should carry, recomputable from its plaintext. */
export function blindValueFor(table, b, row) {
  const normalise = NORMALISERS[b.normalise];
  if (!normalise) throw new Error(`Unknown normaliser '${b.normalise}' for ${table}.${b.column}`);
  const value = normalise(row[b.from]);
  return b.multi
    ? blindIndexMany(fieldKey(table, b.column), row.user_id, value)
    : blindIndex(fieldKey(table, b.column), row.user_id, value);
}

/** Array-aware equality, since a multi index is a text[] column. */
export function blindValueEquals(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}
