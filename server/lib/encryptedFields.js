/**
 * Phase 9.5 — the ONE list of what is encrypted at rest.
 *
 * Everything downstream derives from this file: lib/crypto.js validates every
 * encrypt/decrypt call against it, scripts/encrypt-backfill.mjs builds its JOBS
 * from it, scripts/verify-encryption.mjs gates migration 013 on it, and
 * migrations 012/018/013 must match it column for column.
 *
 * Why a registry rather than a list inside the backfill: the 2026-08-18 audit
 * found that verify-encryption.mjs imported JOBS from the script it was meant to
 * audit, so a column deleted from that list silently vanished from the gate too
 * — the gate would then certify a drop it had never checked. A shared registry
 * that neither script owns removes that failure mode. It also makes the AAD
 * binding in crypto.js checkable: a typo'd field name throws instead of quietly
 * producing a value nothing can ever decrypt.
 *
 * SCOPE RULE: encrypt the MONEY, leave searchable text alone.
 *
 * Deliberately NOT here (and why — do not "fix" these without reading it):
 *   transactions.description   routes/categories.js:89 runs .ilike() on this IN
 *                              THE DATABASE for merchant memory (Task 6.9). You
 *                              cannot ILIKE a ciphertext and decrypting after
 *                              fetch does not help. Encrypting it needs a blind
 *                              index (an HMAC of the normalised merchant, searched
 *                              instead of the text) — a real piece of work, and an
 *                              open product decision for Alex. Until then this is
 *                              the biggest honest gap in the feature: descriptions
 *                              stay readable in the Supabase dashboard.
 *   categories.name            lib/categoryKeywords.js matches on it by name.
 *   savings_goals.name,
 *   savings_contributions.note,
 *   subscription_overrides.display_name,
 *   special_groups.name        Labels, not amounts. Nothing queries them, so they
 *                              can be added later at low cost.
 *   transactions.fx_rate       A PUBLIC market rate. On its own it reveals only
 *                              which currency pair was used on which day, never
 *                              how much. Leaving it plaintext keeps the
 *                              `transactions_fx_sane` CHECK (fx_rate > 0) working
 *                              in the database, which is worth more than hiding a
 *                              number anyone can look up. See original_amount.
 */

/**
 * `kind: 'amount'` routes through encryptAmount/decryptAmount, which refuse '' and
 * NaN. `kind: 'text'` is free-form and only round-trips.
 */
export const ENCRYPTED_FIELDS = [
  { table: 'transactions', column: 'amount', enc: 'amount_enc', kind: 'amount' },

  // Added 2026-08-18. Migration 016 (Phase 12, foreign currency) postdates
  // migration 012 by a month, so this column was in NO list — not 012, not the
  // backfill's JOBS, not the gate. That is not a cosmetic gap: `transactions.amount`
  // is DERIVED as `original_amount * fx_rate` and both were plaintext, so every
  // foreign-currency expense Alex logged in France and Italy had its "encrypted"
  // amount sitting in the dashboard as a one-step multiplication. Encrypting
  // original_amount closes the reconstruction; fx_rate can stay public (above).
  { table: 'transactions', column: 'original_amount', enc: 'original_amount_enc', kind: 'amount' },

  { table: 'budgets', column: 'amount_limit', enc: 'amount_limit_enc', kind: 'amount' },
  { table: 'savings_goals', column: 'target_amount', enc: 'target_amount_enc', kind: 'amount' },
  { table: 'savings_goals', column: 'current_amount', enc: 'current_amount_enc', kind: 'amount' },
  { table: 'savings_contributions', column: 'amount', enc: 'amount_enc', kind: 'amount' },
  { table: 'user_stats', column: 'monthly_limit', enc: 'monthly_limit_enc', kind: 'amount', pk: ['user_id'] },

  // Free-form chat: could contain anything, and nothing queries it.
  { table: 'ask_messages', column: 'content', enc: 'content_enc', kind: 'text' },

  // Task 6.12's recurring schedules carry the same financial data as transactions,
  // and lib/runRecurrences.js inserts a real transaction from them every night.
  { table: 'recurrences', column: 'amount', enc: 'amount_enc', kind: 'amount' },
];

/** 'transactions.amount' — the exact string used as GCM additional authenticated data. */
export const fieldKey = (table, column) => `${table}.${column}`;

const BY_KEY = new Map(ENCRYPTED_FIELDS.map((f) => [fieldKey(f.table, f.column), f]));

/**
 * Throws on an unregistered field. This is the guard that makes AAD safe to
 * require: a typo like 'transaction.amount' cannot silently encrypt under a
 * one-off AAD string that no reader will ever reproduce.
 */
export function requireField(key) {
  const f = BY_KEY.get(key);
  if (!f) throw new Error(`Unknown encrypted field: ${key} (add it to lib/encryptedFields.js)`);
  return f;
}

export const isEncryptedField = (key) => BY_KEY.has(key);

/** Primary key columns for a table, defaulting to the `id` every table but user_stats has. */
export const pkFor = (table) => ENCRYPTED_FIELDS.find((f) => f.table === table)?.pk ?? ['id'];

/** One entry per table, with all of its encrypted columns — the shape the backfill and gate want. */
export function fieldsByTable() {
  const out = new Map();
  for (const f of ENCRYPTED_FIELDS) {
    if (!out.has(f.table)) out.set(f.table, { table: f.table, pk: pkFor(f.table), fields: [] });
    out.get(f.table).fields.push(f);
  }
  return [...out.values()];
}
