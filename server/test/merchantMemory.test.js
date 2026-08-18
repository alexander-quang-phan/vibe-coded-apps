/**
 * Merchant memory must survive `transactions.description` being encrypted.
 *
 * This is the feature the whole blind index exists for: Task 6.9's suggested-
 * category chip in Quick Add, which answers "what did you file this merchant
 * under last time?". It used `.ilike('description', '%term%')` — a search run
 * IN THE DATABASE, which a ciphertext cannot answer.
 *
 * The failure mode being guarded against is silent. If the string hashed on
 * write and the string hashed on read differ by one character, the lookup
 * returns nothing, forever, with no error anywhere — and after migration 013 the
 * plaintext is gone, so it cannot be diagnosed or repaired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { blindIndex } = await import('../lib/crypto.js');
const { normaliseMerchant, normaliseMerchantFirstWord } = await import('../lib/merchant.js');

const U = '00000000-0000-4000-8000-000000000001';
const TWO = 'transactions.merchant_hmac';
const ONE = 'transactions.merchant_hmac_1';

/** What the write path stores on each row. */
const store = (description) => ({
  description,
  merchant_hmac: blindIndex(TWO, U, normaliseMerchant(description)),
  merchant_hmac_1: blindIndex(ONE, U, normaliseMerchantFirstWord(description)),
});

/**
 * What the read path does. The old ILIKE was a SUBSTRING match, so a one-word
 * entry matched a two-word stored description — hence the second index.
 */
function suggest(rows, typed) {
  const two = normaliseMerchant(typed);
  if (!two) return [];
  const oneWord = two.split(' ').length === 1;
  const want = oneWord ? blindIndex(ONE, U, two) : blindIndex(TWO, U, two);
  const col = oneWord ? 'merchant_hmac_1' : 'merchant_hmac';
  return rows.filter((r) => r[col] === want).map((r) => r.description);
}

const ROWS = ['Tesco Express 1234', 'TESCO EXPRESS 9999', 'Tesco Metro 22', "Sainsbury's Local", 'Boots 55']
  .map(store);

test('a two-word entry matches that merchant and not its siblings', () => {
  assert.deepEqual(suggest(ROWS, 'Tesco Express'), ['Tesco Express 1234', 'TESCO EXPRESS 9999']);
});

test('a one-word entry still matches two-word merchants, as the old substring search did', () => {
  assert.deepEqual(suggest(ROWS, 'Tesco'), ['Tesco Express 1234', 'TESCO EXPRESS 9999', 'Tesco Metro 22']);
});

test('case and trailing branch numbers are ignored, as before', () => {
  assert.deepEqual(suggest(ROWS, 'tesco express 777'), ['Tesco Express 1234', 'TESCO EXPRESS 9999']);
});

test("apostrophe merchants now match — they did NOT before", () => {
  // routes/categories.js turned "Sainsbury's" into "sainsbury s" while
  // lib/subscriptions.js turned it into "sainsburys". The ILIKE therefore
  // searched for a string that no stored description contained. Sharing one
  // normalisation fixes a latent bug rather than introducing one.
  assert.deepEqual(suggest(ROWS, "Sainsbury's"), ["Sainsbury's Local"]);
});

test('an unknown merchant matches nothing', () => {
  assert.deepEqual(suggest(ROWS, 'Greggs'), []);
});

test('a blank or punctuation-only entry matches nothing rather than everything', () => {
  for (const q of ['', '   ', '!!!', null]) assert.deepEqual(suggest(ROWS, q), []);
});

test("one user's index never matches another user's rows", () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const want = blindIndex(ONE, other, 'tesco');
  assert.equal(ROWS.filter((r) => r.merchant_hmac_1 === want).length, 0);
});
