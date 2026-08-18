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

/**
 * Longest prefix that is HASHED — on BOTH sides. Was 24 until 2026-08-18.
 *
 * Reduced to 8 after Codex's stage-4 RE-VERIFY findings 3 and 4, which are two
 * faces of the same design flaw:
 *
 *   3. Storing every prefix from 2 to 24 does not merely reveal "these rows share
 *      a merchant" (the documented claim). It publishes a same-user prefix TRIE.
 *      Comparing two rows' arrays gives the exact number of leading normalised
 *      characters they share, so "Tesco Express" and "Tesco Metro" visibly share
 *      six; every `Tesco` row is visibly a prefix-family of the longer ones; and
 *      the array's cardinality gives the merchant's exact normalised LENGTH.
 *      One known row therefore labels its whole prefix path and clusters its
 *      neighbours.
 *   4. The read path hashed the UNCAPPED normalised query, so a 25-character
 *      merchant produced a hash no stored row could ever carry: matching worked
 *      at 24 characters and silently stopped at 25.
 *
 * A single cap that BOTH sides apply fixes 4 by construction, and lowering it
 * bounds 3: nothing above `MAX_PREFIX` characters is ever hashed, so the trie is
 * at most 8 deep and the length leak saturates at 8 (every merchant of 8+
 * normalised characters now stores an identically sized array).
 *
 * Above the cap the lookup stays EXACT rather than becoming approximate — see
 * merchantMatches(). The hash narrows to candidates; the server decrypts those
 * candidates and applies the real prefix test. So the contract is unchanged at
 * every length, and only the leakage moved.
 *
 * WHAT IS STILL LEAKED, precisely (SECURITY.md carries the same wording):
 *   - which rows share the same first 2..8 normalised characters, and how many;
 *   - the exact normalised length of merchants SHORTER than 8 characters
 *     ("kfc" stores 2 hashes, "aldi" 3), and otherwise only "8 or longer".
 * Removing the rest would mean giving up the database-side typeahead entirely.
 */
export const MAX_PREFIX = 8;

/**
 * Every prefix of the normalised merchant, from MIN_PREFIX characters up to
 * MAX_PREFIX. This is the WRITE side of the blind index.
 *
 * Merchant memory is a TYPEAHEAD: QuickAddDialog.jsx:154-167 fires
 * GET /api/categories/suggest on every keystroke (250ms debounce) from the second
 * character. The old `.ilike('description', '%term%')` matched a partial word
 * naturally, so the category chip lit up while the user was still typing "Tes".
 *
 * A hash matches only what it hashed, so an exact-match index would light the
 * chip only once the merchant was typed out in full — the feature would look
 * broken rather than helpful. Storing the prefixes keeps the typeahead working:
 * the read path hashes what the user has typed so far (capped identically, see
 * merchantQueryPrefix) and asks whether any row carries that hash.
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

/**
 * The READ side of the same index: the exact string a lookup must hash.
 *
 * This exists so the two sides CANNOT drift. Before it, the read path hashed
 * `normaliseMerchant(typed)` uncapped while the write path capped at 24, so a
 * long merchant matched at 24 characters and stopped matching at 25 — a silent,
 * length-dependent dead zone. [Codex stage-4 RE-VERIFY finding 4, 2026-08-18]
 *
 * Returns null when there is nothing hashable (blank, punctuation-only, or a
 * single character — the route requires two, matching the client).
 */
export function merchantQueryPrefix(typed) {
  const full = normaliseMerchant(typed);
  if (!full) return null;
  const capped = full.slice(0, MAX_PREFIX);
  return capped.length >= MIN_PREFIX ? capped : null;
}

/**
 * The EXACT predicate the hash only approximates.
 *
 * A query longer than MAX_PREFIX hashes to its first MAX_PREFIX characters, so
 * the database returns a SUPERSET: typing "tesco expressway" also matches
 * "Tesco Express". The server holds the key, so it decrypts each candidate and
 * applies this test — which is the original `startsWith` contract at every
 * length. Callers that skip it get approximate results above the cap; the
 * suggested-category route must not.
 */
export function merchantMatches(description, typed) {
  const want = normaliseMerchant(typed);
  const have = normaliseMerchant(description);
  if (!want || !have) return false;
  return have.startsWith(want);
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
