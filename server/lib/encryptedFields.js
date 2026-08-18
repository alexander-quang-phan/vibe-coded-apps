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
 * SCOPE EXPANDED 2026-08-18 (Alex): encrypt descriptions too, via a blind index.
 * Amounts alone left the dashboard showing WHAT was bought — "Boots",
 * "Pharmacy", a therapist's name — while hiding only how much. Free-text labels
 * came with it, since nothing queries them.
 *
 * Deliberately NOT here (and why — do not "fix" these without reading it):
 *   categories.name            routes/categories.js:112 looks a category up by
 *                              `.eq('name', keywordName)` in the DATABASE, and
 *                              lib/categoryKeywords.js matches on it by name.
 *                              It is also just the 12 seeded defaults
 *                              ("Groceries", "Transport"), which reveal nothing
 *                              about a particular person's spending.
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

  // --- free text, added 2026-08-18 ------------------------------------------

  // The one that needed a blind index. See BLIND_INDEXES below.
  { table: 'transactions', column: 'description', enc: 'description_enc', kind: 'text' },

  // The same merchant text as a transaction — runRecurrences.js copies it into
  // one every night, so leaving it readable would leak every recurring merchant.
  { table: 'recurrences', column: 'description', enc: 'description_enc', kind: 'text' },

  // Labels. Nothing queries any of these in the database (verified 2026-08-18:
  // goals and special groups are ordered by created_at, never by name), so they
  // cost nothing but a column each.
  { table: 'savings_goals', column: 'name', enc: 'name_enc', kind: 'text' },
  { table: 'savings_contributions', column: 'note', enc: 'note_enc', kind: 'text' },
  { table: 'special_groups', column: 'name', enc: 'name_enc', kind: 'text' },

  // The display name of a detected subscription — "Netflix", "PureGym". Its
  // table has a COMPOSITE primary key, which is why the backfill keeps an
  // offset-paging path.
  {
    table: 'subscription_overrides',
    column: 'display_name',
    enc: 'display_name_enc',
    kind: 'text',
    pk: ['user_id', 'merchant_key'],
  },
];

/**
 * Blind indexes — keyed hashes stored beside an encrypted column so the database
 * can still answer an equality lookup it could otherwise only answer in plaintext.
 * See blindIndex() in lib/crypto.js for the privacy trade this makes.
 *
 * `from` is the PLAINTEXT column each is derived from, and `normalise` is applied
 * before hashing. Both the write path and the read path must use this table —
 * a blind index whose two sides disagree by one character silently returns
 * nothing, forever, with no error.
 */
export const BLIND_INDEXES = [
  // Merchant memory: routes/categories.js used `.ilike('description', '%term%')`
  // where `term` was already the first two normalised words. Hashing that same
  // normalised key reproduces the lookup as an equality match.
  {
    table: 'transactions',
    column: 'merchant_hmac',
    from: 'description',
    normalise: 'merchant',
  },
  // The old ILIKE was a SUBSTRING match, so a one-word entry ("Tesco") matched a
  // two-word stored description ("Tesco Express 1234"). A hash matches only
  // exactly, so the one-word case needs its own index or partial entries
  // silently stop suggesting.
  {
    table: 'transactions',
    column: 'merchant_hmac_1',
    from: 'description',
    normalise: 'merchantFirstWord',
  },
  // subscription_overrides.merchant_key is the PRIMARY KEY and holds either the
  // normalised merchant ("netflix") or a synthetic key that embeds an amount
  // bucket ("auto:<cat>:25:monthly") — so it leaks both merchants AND roughly
  // what they cost, in a column no encryption touched. Hashing it keeps the
  // equality lookup and the upsert conflict target working while making it
  // opaque. Migration 013 moves the primary key onto this column.
  {
    table: 'subscription_overrides',
    column: 'merchant_key_hmac',
    from: 'merchant_key',
    normalise: 'identity',
  },
];


/** 'transactions.amount' — the exact string used as GCM additional authenticated data. */
export const fieldKey = (table, column) => `${table}.${column}`;

const BY_KEY = new Map(ENCRYPTED_FIELDS.map((f) => [fieldKey(f.table, f.column), f]));

const BLIND_BY_KEY = new Map(BLIND_INDEXES.map((b) => [fieldKey(b.table, b.column), b]));

export function requireBlindIndex(key) {
  const b = BLIND_BY_KEY.get(key);
  if (!b) throw new Error(`Unknown blind index: ${key} (add it to lib/encryptedFields.js)`);
  return b;
}

export const blindIndexesFor = (table) => BLIND_INDEXES.filter((b) => b.table === table);

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

/** Primary key columns for a table, defaulting to the `id` most tables have. */
export const pkFor = (table) => ENCRYPTED_FIELDS.find((f) => f.table === table && f.pk)?.pk ?? ['id'];

/** One entry per table, with all of its encrypted columns — the shape the backfill and gate want. */
export function fieldsByTable() {
  const out = new Map();
  for (const f of ENCRYPTED_FIELDS) {
    if (!out.has(f.table)) {
      out.set(f.table, { table: f.table, pk: pkFor(f.table), fields: [], blind: blindIndexesFor(f.table) });
    }
    out.get(f.table).fields.push(f);
  }
  return [...out.values()];
}
