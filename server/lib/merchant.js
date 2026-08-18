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
 * First word only. Merchant memory's old `.ilike('%term%')` was a SUBSTRING
 * match, so a one-word entry ("Tesco") matched a two-word stored description
 * ("Tesco Express 1234"). A hash only matches exactly, so that case needs its
 * own index or the suggestion silently stops working for partial entries.
 */
export function normaliseMerchantFirstWord(description) {
  const two = normaliseMerchant(description);
  return two ? two.split(' ')[0] : null;
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
