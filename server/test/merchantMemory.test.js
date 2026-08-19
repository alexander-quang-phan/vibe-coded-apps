/**
 * lib/merchant.js — the normalisation and the blind-index prefix scheme.
 *
 * SCOPE NOTE, 2026-08-18. This file used to carry its own `runSuggest()` model of
 * the read path: a loop over a pre-materialised array that already knew how many
 * candidates existed. Codex's stage-5 RE-VERIFY #3 finding 4 was right that this
 * proved nothing about production — there was no production read path at all, and
 * a "pagination fix" that lives only in its own test is not a fix.
 *
 * The read path is now real code (`lib/merchantMemory.js`) and is tested against a
 * paging, short-paging, failing fake in `test/merchantMemoryRead.test.js`. What is
 * left here is what belongs here: the pure functions, the symmetry of the cap, and
 * the leakage the prefix scheme is allowed to have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const {
  merchantPrefixes, merchantQueryPrefix, merchantMatches, merchantContains,
  normaliseMerchant, normaliseFull, normaliseMerchantFirstWord, MAX_PREFIX, MIN_PREFIX,
} = await import('../lib/merchant.js');

// --- one normalisation, and the apostrophe bug it fixed ----------------------

test('ONE normalisation: apostrophes vanish rather than splitting a word', () => {
  // routes/categories.js turned "Sainsbury's" into "sainsbury s" while
  // lib/subscriptions.js turned it into "sainsburys", so the ILIKE searched for a
  // string no stored description contained — merchant memory had silently never
  // matched an apostrophe merchant.
  assert.equal(normaliseMerchant("Sainsbury's Local"), 'sainsburys local');
  assert.equal(normaliseMerchant("McDonald's"), 'mcdonalds');
  assert.equal(normaliseMerchant('Sainsbury’s Local'), 'sainsburys local', 'curly apostrophe too');
});

test('normalisation keeps the first two words, lowercased and de-punctuated', () => {
  assert.equal(normaliseMerchant('Tesco Express 1234'), 'tesco express');
  assert.equal(normaliseMerchant('TESCO EXPRESS 9999'), 'tesco express');
  assert.equal(normaliseMerchantFirstWord('Tesco Express 1234'), 'tesco');
  for (const blank of ['', '   ', '!!!', null, undefined]) {
    assert.equal(normaliseMerchant(blank), null, JSON.stringify(blank));
  }
});

test('normaliseFull keeps every word — that is what %term% searched', () => {
  assert.equal(normaliseFull('Tesco Express 1234 London'), 'tesco express 1234 london');
  assert.equal(normaliseFull('!!!'), null);
});

// --- the cap, symmetric on both sides ---------------------------------------

const LONG = 'Sainsburys Superstore Kensington'; // normalises to 21 characters

test('RE-VERIFY REGRESSION: both sides hash the identical capped string', () => {
  // Stored prefixes stopped at the cap while the read path hashed the UNCAPPED
  // query, so matching worked at 24 characters and silently died at 25.
  const stored = merchantPrefixes(LONG);
  const queried = merchantQueryPrefix(`${LONG} and more words`);
  assert.equal(queried, stored[stored.length - 1], 'the read hash must be the longest stored prefix');
  assert.equal(queried.length, MAX_PREFIX);
});

test('RE-VERIFY REGRESSION: the exact test holds at every query length', () => {
  const full = normaliseMerchant(LONG);
  assert.ok(full.length > MAX_PREFIX, 'this fixture must be longer than the cap to be meaningful');
  for (let k = MIN_PREFIX; k <= full.length; k += 1) {
    assert.ok(merchantMatches(LONG, full.slice(0, k)), `${k} characters must still match`);
  }
});

test('a query that diverges after the cap does not match', () => {
  // Above the cap the index returns a superset; this predicate is what decides.
  assert.ok(!merchantMatches(LONG, 'Sainsburys Local'));
  assert.ok(merchantMatches(LONG, 'Sainsburys Superstore'));
});

test('a one-character query has nothing to hash', () => {
  assert.equal(merchantQueryPrefix('T'), null);
  assert.equal(merchantQueryPrefix('!'), null);
});

// --- the substring contract Task 6.9 actually shipped ------------------------

test('merchantContains reproduces %term%, including mid-word and later words', () => {
  // The previous revision recorded both of these as accepted losses. The spec
  // never accepted them. [Codex stage-5 RE-VERIFY #3 finding 4, 2026-08-18]
  assert.ok(merchantContains('Tesco Express 1234', 'esco'), 'mid-word');
  assert.ok(merchantContains('Tesco Express 1234', 'Express'), 'later word');
  assert.ok(merchantContains('Tesco Express 1234', 'Tesco'), 'and still the prefix case');
  assert.ok(!merchantContains('Boots 55', 'esco'));
  assert.ok(!merchantContains('Tesco Express', ''));
});

test('prefix matching is a STRICTER rule than the substring one', () => {
  // Which is exactly why the index alone cannot be the contract: it is the fast
  // path, and lib/merchantMemory.js falls back to the substring rule.
  assert.ok(!merchantMatches('Tesco Express', 'esco'));
  assert.ok(merchantContains('Tesco Express', 'esco'));
});

// --- the leakage the scheme is allowed to have ------------------------------

test('RE-VERIFY REGRESSION: the stored prefix set cannot exceed the cap', () => {
  // Every row used to carry 23 hashes, which is a prefix TRIE: comparing two rows
  // gave their exact longest common prefix, and the array's length gave the
  // merchant's exact normalised length.
  for (const desc of [LONG, 'Tesco Express 1234', 'Waterstones Piccadilly']) {
    const p = merchantPrefixes(desc);
    assert.ok(p.length <= MAX_PREFIX - 1, `${desc} stored ${p.length} prefixes`);
    assert.ok(p.every((s) => s.length <= MAX_PREFIX));
  }
});

test('RE-VERIFY REGRESSION: array length no longer reveals the merchant length', () => {
  const a = merchantPrefixes('Sainsburys Superstore Kensington'); // 21 normalised chars
  const b = merchantPrefixes('Waterstones Piccadilly');           // 22 normalised chars
  const c = merchantPrefixes('Tesco Express');                    // 13 normalised chars
  assert.equal(a.length, b.length);
  assert.equal(a.length, c.length);
});

test('RE-VERIFY REGRESSION: common prefixes beyond the cap are indistinguishable', () => {
  // "sainsburys superstore" and "sainsburys supermarket" share 14 normalised
  // characters. The stored arrays must be IDENTICAL, so the database cannot tell
  // that from the 8 characters it can see — the trie is bounded, not published.
  assert.deepEqual(
    merchantPrefixes('Sainsburys Superstore'),
    merchantPrefixes('Sainsburys Supermarket'),
  );
});

test('WHAT IS STILL LEAKED, pinned so SECURITY.md cannot drift from it', () => {
  // Below the cap the scheme DOES expose a bounded trie: exact common-prefix
  // length, strict-prefix families, and — for short names — the exact length.
  // SECURITY.md says this in the same words; these assertions are what keep it
  // honest. [Codex stage-5 RE-VERIFY #3 finding 5, 2026-08-18]
  const tescoExpress = merchantPrefixes('Tesco Express');
  const tescoMetro = merchantPrefixes('Tesco Metro');
  const shared = tescoExpress.filter((x) => tescoMetro.includes(x));
  assert.deepEqual(shared, ['te', 'tes', 'tesc', 'tesco', 'tesco '],
    'the exact number of shared leading characters is visible below the cap');

  // A short merchant is a strict prefix family of a longer one starting the same.
  const kfc = merchantPrefixes('KFC');
  assert.deepEqual(kfc, ['kf', 'kfc']);
  assert.equal(merchantPrefixes('Aldi').length, 3, 'short names still reveal their length');
});
