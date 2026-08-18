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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { blindIndex, blindIndexMany } = await import('../lib/crypto.js');
const { merchantPrefixes, normaliseMerchant } = await import('../lib/merchant.js');

const U = '00000000-0000-4000-8000-000000000001';
const IDX = 'transactions.merchant_prefix_hmacs';

/** The write path: what the backfill/routes store on each row. */
const store = (description, category_id) => ({
  description,
  category_id,
  merchant_prefix_hmacs: blindIndexMany(IDX, U, merchantPrefixes(description)),
});

/**
 * The read path — mirrors routes/categories.js `/suggest` including the parts
 * Codex noted were untested: the >=2 char gate, the vote count over matches, and
 * the `count >= 3 ? 'high' : 'medium'` confidence rule.
 */
function suggest(rows, typed, { userId = U } = {}) {
  const desc = String(typed ?? '').trim();
  if (desc.length < 2) return { categoryId: null, confidence: 'none', source: 'none' };
  const term = normaliseMerchant(desc);
  if (!term) return { categoryId: null, confidence: 'none', source: 'none' };

  const want = blindIndex(IDX, userId, term);
  const matches = rows.filter((r) => (r.merchant_prefix_hmacs ?? []).includes(want));

  if (matches.length > 0) {
    const counts = new Map();
    for (const m of matches) counts.set(m.category_id, (counts.get(m.category_id) ?? 0) + 1);
    const [categoryId, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return { categoryId, confidence: count >= 3 ? 'high' : 'medium', source: 'history' };
  }
  return { categoryId: null, confidence: 'none', source: 'none' };
}

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
  assert.deepEqual(suggest(ROWS, 'T'), { categoryId: null, confidence: 'none', source: 'none' });
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
  assert.deepEqual(suggest(ROWS, 'Greggs'), { categoryId: null, confidence: 'none', source: 'none' });
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
