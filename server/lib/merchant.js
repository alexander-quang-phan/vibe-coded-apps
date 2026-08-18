/**
 * The ONE merchant normalisation.
 *
 * Extracted from lib/subscriptions.js 2026-08-18, when encrypting
 * `transactions.description` forced merchant memory onto a blind index. A blind
 * index is an equality lookup over a hash, so the string being hashed on write
 * and the string being hashed on read must come from the same function —
 * "close enough" silently returns no matches forever.
 *
 * They were NOT the same before. routes/categories.js had its own inline copy
 * that stripped apostrophes as part of the general non-alphanumeric sweep, while
 * this one removes them first:
 *
 *     "Sainsbury's Local"  ->  subscriptions: "sainsburys local"
 *                              categories:    "sainsbury s"
 *     "McDonald's"         ->  subscriptions: "mcdonalds"
 *                              categories:    "mcdonald s"
 *
 * So for every apostrophe merchant, subscription detection and the suggested-
 * category chip already disagreed about what the merchant was called. Unifying
 * them is a behaviour change, and a fix.
 */

/** First two words of a description, lowercased, punctuation removed. */
export function normaliseMerchant(description) {
  if (!description) return null;
  const cleaned = String(description)
    .toLowerCase()
    // Apostrophes vanish rather than becoming a word break: "sainsburys", not
    // "sainsbury s". Both the curly and straight forms — a phone keyboard emits
    // the curly one and a desktop the straight one, for the same shop.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(' ').filter(Boolean).slice(0, 2);
  if (words.length === 0) return null;
  return words.join(' ');
}

/**
 * First word only. Kept for callers that want it; the blind index uses
 * merchantPrefixes() instead.
 */
export function normaliseMerchantFirstWord(description) {
  const two = normaliseMerchant(description);
  return two ? two.split(' ')[0] : null;
}

/** Shortest prefix the client will ever send — QuickAddDialog requires 2 chars. */
export const MIN_PREFIX = 2;
/** Longest prefix worth storing. Bounds the array; nobody types past this. */
export const MAX_PREFIX = 24;

/**
 * Every prefix of the normalised merchant, from MIN_PREFIX characters up.
 *
 * Merchant memory is a TYPEAHEAD: QuickAddDialog.jsx:154-167 fires
 * GET /api/categories/suggest on every keystroke (250ms debounce) from the second
 * character. The old `.ilike('description', '%term%')` matched a partial word
 * naturally, so the category chip lit up while the user was still typing "Tes".
 *
 * A hash matches only what it hashed, so an exact-match index would light the
 * chip only once the merchant was typed out in full — the feature would look
 * broken rather than helpful. Storing the prefixes keeps the typeahead working:
 * the read path hashes what the user has typed so far and asks whether any row
 * carries that hash.
 *
 * WHAT THIS COSTS, stated plainly: the array length reveals how long the merchant
 * name is (not what it is). That is a real, if small, addition to what a blind
 * index already leaks — which rows share a merchant. Both are documented in
 * SECURITY.md.
 *
 * WHAT IS STILL LOST vs the old ILIKE, deliberately:
 *   - infix matching. Typing "esco" used to find "Tesco"; now it does not.
 *   - second-word-only matching. Typing "Express" used to find "Tesco Express".
 * Both are unreachable without hashing every substring, which would leak far more
 * and bloat every row. Accepted as a narrower contract.
 */
export function merchantPrefixes(description) {
  const full = normaliseMerchant(description);
  if (!full) return null;
  const capped = full.slice(0, MAX_PREFIX);
  const out = [];
  for (let i = MIN_PREFIX; i <= capped.length; i += 1) out.push(capped.slice(0, i));
  return out.length ? out : null;
}

export function prettifyMerchant(description, fallbackKey) {
  const source = description ?? fallbackKey ?? '';
  const words = String(source)
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (words.length === 0) return fallbackKey ?? '';
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
