/**
 * Merchant memory must survive `transactions.description` being encrypted.
 *
 * This is Task 6.9's suggested-category chip in Quick Add. It used
 * `.ilike('description', '%term%')` — a search run IN THE DATABASE, which a
 * ciphertext cannot answer — and it is a TYPEAHEAD: QuickAddDialog.jsx fires it
 * on every keystroke from the second character.
 *
 * The failure mode is silent. If the string hashed on write and the string
 * hashed on read differ, the lookup returns nothing forever with no error, and
 * after migration 019 the plaintext is gone so it cannot be diagnosed.
 *
 * REWRITTEN 2026-08-18 after Codex's stage-4 VERIFY: the previous version modelled
 * prefix EQUALITY and stopped there, so it neither exercised the typeahead nor the
 * route's actual vote-counting and confidence rules.
 *
 * REVISED 2026-08-18 after Codex's stage-4 RE-VERIFY findings 3 and 4. The read
 * path hashed the UNCAPPED query while the write path capped at 24, so matching
 * silently died at 25 characters; and storing 23 prefixes per row published a
 * same-user prefix trie rather than the "which rows share a merchant" the docs
 * claimed. Both sides now share one cap, and the exactness that the smaller cap
 * gives up is recovered by refining on the decrypted text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { blindIndex, blindIndexMany } = await import('../lib/crypto.js');
const {
  merchantPrefixes, merchantQueryPrefix, merchantMatches, normaliseMerchant, MAX_PREFIX,
} = await import('../lib/merchant.js');

const U = '00000000-0000-4000-8000-000000000001';
const IDX = 'transactions.merchant_prefix_hmacs';

/** The write path: what the backfill/routes store on each row. */
let nextId = 0;
const store = (description, category_id) => ({
  // A stable ordering key. The read path pages, and paging without a stable order
  // can show a row twice and never show another.
  id: String(nextId++).padStart(6, '0'),
  description,
  category_id,
  merchant_prefix_hmacs: blindIndexMany(IDX, U, merchantPrefixes(description)),
});

/** The route's cap on how many history rows it will weigh. */
const MATCH_LIMIT = 200;

const NONE = { categoryId: null, confidence: 'none', source: 'none' };

/**
 * The read path — mirrors routes/categories.js `/suggest` including the parts
 * Codex noted were untested: the >=2 char gate, the vote count over matches, and
 * the `count >= 3 ? 'high' : 'medium'` confidence rule.
 *
 * TWO STEPS, and the second one is not optional:
 *   1. the DATABASE narrows on the hash — a GIN containment scan over
 *      merchant_prefix_hmacs, which above MAX_PREFIX characters returns a
 *      SUPERSET because only the first MAX_PREFIX characters were ever hashed;
 *   2. the SERVER decrypts each candidate and applies the exact prefix test.
 * Skipping step 2 would make long queries approximate. The route must not.
 */
function runSuggest(rows, typed, { userId = U, pageSize = MATCH_LIMIT, limit = MATCH_LIMIT } = {}) {
  const desc = String(typed ?? '').trim();
  if (desc.length < 2) return { result: NONE, candidates: 0, pagesRead: 0 };

  const prefix = merchantQueryPrefix(desc);
  if (!prefix) return { result: NONE, candidates: 0, pagesRead: 0 };

  const want = blindIndex(IDX, userId, prefix);

  // What the DATABASE can answer: a GIN containment scan on the hash, in a stable
  // primary-key order so paging is well defined.
  const candidates = rows
    .filter((r) => (r.merchant_prefix_hmacs ?? []).includes(want))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // What the SERVER must then do: page through those candidates, decrypting and
  // applying the exact test, until it has `limit` real matches or has run out.
  //
  // Doing it the other way round — `.limit(200)` in the query, then refine what
  // came back — silently loses true matches whenever 200 rows share the capped
  // prefix ahead of them. [Codex stage-5 RE-VERIFY #2 finding 5, 2026-08-18]
  const matches = [];
  let offset = 0;
  let pagesRead = 0;
  while (offset < candidates.length && matches.length < limit) {
    const page = candidates.slice(offset, offset + pageSize);
    pagesRead += 1;
    offset += page.length;
    // `r.description` stands in for decrypt(description_enc) — the server holds
    // the key, so this is available to it and to nothing else.
    for (const r of page) {
      if (merchantMatches(r.description, desc)) matches.push(r);
      if (matches.length >= limit) break;
    }
  }

  if (matches.length > 0) {
    const counts = new Map();
    for (const m of matches) counts.set(m.category_id, (counts.get(m.category_id) ?? 0) + 1);
    const [categoryId, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      result: { categoryId, confidence: count >= 3 ? 'high' : 'medium', source: 'history' },
      candidates: candidates.length,
      pagesRead,
    };
  }
  return { result: NONE, candidates: candidates.length, pagesRead };
}

const suggest = (rows, typed, opts) => runSuggest(rows, typed, opts).result;

const GROCERIES = 'cat-groceries';
const HEALTH = 'cat-health';
const ROWS = [
  store('Tesco Express 1234', GROCERIES),
  store('TESCO EXPRESS 9999', GROCERIES),
  store('Tesco Metro 22', GROCERIES),
  store("Sainsbury's Local", GROCERIES),
  store('Boots 55', HEALTH),
];

// --- the typeahead, keystroke by keystroke -----------------------------------

test('the chip lights up WHILE typing, not only on the completed word', () => {
  // The regression that an exact-match index would have caused: nothing matches
  // until "tesco" is finished. QuickAddDialog fires from the 2nd character.
  for (const partial of ['Te', 'Tes', 'Tesc', 'Tesco']) {
    const r = suggest(ROWS, partial);
    assert.equal(r.categoryId, GROCERIES, `typing "${partial}" should already suggest Groceries`);
    assert.equal(r.source, 'history');
  }
});

test('typing into the second word narrows to that merchant', () => {
  assert.equal(suggest(ROWS, 'Tesco Ex').categoryId, GROCERIES);
  // "tesco m" is Metro only — still Groceries, but proves the prefix is honoured
  const onlyMetro = ROWS.filter((r) => (r.merchant_prefix_hmacs ?? [])
    .includes(blindIndex(IDX, U, 'tesco m')));
  assert.equal(onlyMetro.length, 1);
});

test('a one-character entry never queries — the route requires two', () => {
  assert.deepEqual(suggest(ROWS, 'T'), NONE);
});

// --- vote counting and confidence, the parts the route actually returns ------

test('confidence is high only from three or more matching transactions', () => {
  // "tesco" matches all three Tesco rows -> high.
  assert.equal(suggest(ROWS, 'Tesco').confidence, 'high');
  // "tesco ex" matches the two Express rows -> medium.
  assert.equal(suggest(ROWS, 'Tesco Ex').confidence, 'medium');
  // Boots is a single row -> medium.
  assert.equal(suggest(ROWS, 'Boots').confidence, 'medium');
});

test('the winning category is the most-voted, not the first seen', () => {
  const mixed = [
    store('Boots 1', GROCERIES), // one stray miscategorisation
    store('Boots 2', HEALTH),
    store('Boots 3', HEALTH),
    store('Boots 4', HEALTH),
  ];
  const r = suggest(mixed, 'Boots');
  assert.equal(r.categoryId, HEALTH);
  assert.equal(r.confidence, 'high'); // 3 votes
});

// --- behaviour preserved from the old ILIKE ----------------------------------

test('case and trailing branch numbers are ignored, as before', () => {
  assert.equal(suggest(ROWS, 'tesco express 777').categoryId, GROCERIES);
});

test("apostrophe merchants now match — they did NOT before", () => {
  // routes/categories.js turned "Sainsbury's" into "sainsbury s" while
  // lib/subscriptions.js turned it into "sainsburys", so the ILIKE searched for a
  // string no stored description contained. One shared normalisation fixes it.
  assert.equal(suggest(ROWS, "Sainsbury's").categoryId, GROCERIES);
});

test('an unknown merchant matches nothing', () => {
  assert.deepEqual(suggest(ROWS, 'Greggs'), NONE);
});

test('blank and punctuation-only entries match nothing rather than everything', () => {
  for (const q of ['', '   ', '!!!', null, undefined]) {
    assert.equal(suggest(ROWS, q).categoryId, null, `${JSON.stringify(q)} must not match`);
  }
});

test("one user's index never matches another user's rows", () => {
  const other = '00000000-0000-4000-8000-000000000002';
  assert.equal(suggest(ROWS, 'Tesco', { userId: other }).categoryId, null);
});

// --- the narrower contract, stated as tests so it is not a surprise ----------

test('DOCUMENTED LOSS: infix matching no longer works', () => {
  // Old: `.ilike('%esco%')` found "Tesco". Hashing prefixes cannot. Covering it
  // would mean hashing every substring — far more leakage and a much bigger row.
  assert.equal(suggest(ROWS, 'esco').categoryId, null);
});

test('DOCUMENTED LOSS: second-word-only matching no longer works', () => {
  // Old: `.ilike('%express%')` found "Tesco Express".
  assert.equal(suggest(ROWS, 'Express').categoryId, null);
});

// --- Codex stage-4 RE-VERIFY finding 4: the cap must be symmetric ------------

const LONG = 'Sainsburys Superstore Kensington'; // normalises to 21 characters
const LONG_ROWS = [store(LONG, GROCERIES)];

test('RE-VERIFY REGRESSION: matching does not die past the prefix cap', () => {
  // The exact defect: stored prefixes stopped at MAX_PREFIX while the read path
  // hashed the uncapped query, so a long merchant matched up to the cap and
  // silently stopped one character later. Codex measured 23/24 matching and
  // 25/26 not. Every length must match, including well past the cap.
  const full = normaliseMerchant(LONG);
  assert.ok(full.length > MAX_PREFIX, 'this fixture must be longer than the cap to be meaningful');

  for (let k = 2; k <= full.length; k += 1) {
    const typed = full.slice(0, k);
    assert.equal(
      suggest(LONG_ROWS, typed).categoryId,
      GROCERIES,
      `typing ${k} characters ("${typed}") must still match`,
    );
  }
});

test('RE-VERIFY REGRESSION: both sides hash the identical capped string', () => {
  // One function per side, and above the cap they must agree exactly. This is
  // the invariant whose absence caused the dead zone.
  const stored = merchantPrefixes(LONG);
  const queried = merchantQueryPrefix(`${LONG} extra words that go on and on`);
  assert.equal(queried, stored[stored.length - 1], 'the read hash must be the longest stored prefix');
  assert.equal(queried.length, MAX_PREFIX);
});

test('a longer query that diverges after the cap must NOT match', () => {
  // Above the cap the hash returns a superset, so the exact test on the decrypted
  // text is what keeps the contract honest. "sainsburys local" shares the first
  // eight characters with "sainsburys superstore" and must still not match it.
  assert.equal(suggest(LONG_ROWS, 'Sainsburys Local').categoryId, null);
  assert.equal(suggest(LONG_ROWS, 'Sainsburys Superstore').categoryId, GROCERIES);
});

test('the hash alone is a SUPERSET above the cap — the refinement is load-bearing', () => {
  // Stated as a test so nobody "optimises away" step 2 of the read path.
  const want = blindIndex(IDX, U, merchantQueryPrefix('Sainsburys Local'));
  const candidates = LONG_ROWS.filter((r) => (r.merchant_prefix_hmacs ?? []).includes(want));
  assert.equal(candidates.length, 1, 'the database cannot tell these apart');
  assert.equal(candidates.filter((r) => merchantMatches(r.description, 'Sainsburys Local')).length, 0);
});

// --- Codex stage-4 RE-VERIFY finding 3: the trie must be bounded -------------

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
  // Two merchants of very different lengths must store identically sized arrays,
  // so the cardinality says only "at least MAX_PREFIX characters".
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
  const a = merchantPrefixes('Sainsburys Superstore');
  const b = merchantPrefixes('Sainsburys Supermarket');
  assert.deepEqual(a, b);
});

test('short merchants still reveal their length — stated, not hidden', () => {
  // The residual leak, pinned so it stays documented in SECURITY.md. A merchant
  // shorter than the cap stores fewer hashes, and that count is its length.
  assert.equal(merchantPrefixes('KFC').length, 2);   // 'kf', 'kfc'
  assert.equal(merchantPrefixes('Aldi').length, 3);  // 'al', 'ald', 'aldi'
});


// --- Codex stage-5 RE-VERIFY #2 finding 5: the 200-row candidate limit -------

test('RE-VERIFY REGRESSION: true matches survive 200 rows sharing the capped prefix', () => {
  // Codex's probe, reproduced. 200 rows whose normalised merchant is
  // "sainsburys superstore" and three that are "sainsburys local" — all 203 share
  // the capped prefix "sainsbur", so the database cannot tell them apart and the
  // three real ones sort last.
  //
  // Measured then: { candidates: 203, limitedThenRefined: 0, refinedThenLimited: 3 }.
  const noise = Array.from({ length: 200 }, (_, i) => store(`Sainsburys Superstore ${i}`, HEALTH));
  const truth = [
    store('Sainsburys Local Camden', GROCERIES),
    store('Sainsburys Local Holborn', GROCERIES),
    store('Sainsburys Local Euston', GROCERIES),
  ];
  const table = [...noise, ...truth];

  const { result, candidates, pagesRead } = runSuggest(table, 'Sainsburys Local');
  assert.equal(candidates, 203, 'all 203 share the capped prefix — that is the point');
  assert.ok(pagesRead > 1, 'the route must keep reading past the first page');
  assert.equal(result.categoryId, GROCERIES, 'the three true matches must not be lost');
  assert.equal(result.confidence, 'high', 'three matches is high confidence');

  // And the naive order — cap first, refine after — is exactly what loses them.
  const stable = table
    .filter((r) => (r.merchant_prefix_hmacs ?? []).includes(blindIndex(IDX, U, merchantQueryPrefix('Sainsburys Local'))))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const limitedThenRefined = stable
    .slice(0, MATCH_LIMIT)
    .filter((r) => merchantMatches(r.description, 'Sainsburys Local'));
  assert.equal(limitedThenRefined.length, 0, 'this is the defect: refining after the limit finds nothing');
});

test('paging stops once the match limit is reached, not after reading everything', () => {
  // The cap still has to cap: a merchant with thousands of rows must not read the
  // whole table on every keystroke.
  const many = Array.from({ length: 500 }, () => store('Tesco Express', GROCERIES));
  const { result, pagesRead } = runSuggest(many, 'Tesco', { pageSize: 50, limit: 100 });
  assert.equal(result.confidence, 'high');
  assert.equal(pagesRead, 2, 'two 50-row pages reach the 100-match limit and stop');
});

test('paging uses a stable order, so no candidate is read twice or skipped', () => {
  const rows = Array.from({ length: 25 }, (_, i) => store(`Boots ${i}`, HEALTH));
  const { result, candidates } = runSuggest(rows, 'Boots', { pageSize: 4 });
  assert.equal(candidates, 25);
  assert.equal(result.categoryId, HEALTH);
  assert.equal(result.confidence, 'high');
});
