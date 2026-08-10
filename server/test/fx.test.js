import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalsFor, convertToBase, describeConversion } from '../lib/fx.js';

test('decimals follow the currency, and VND has none', () => {
  assert.equal(decimalsFor('GBP'), 2);
  assert.equal(decimalsFor('USD'), 2);
  assert.equal(decimalsFor('PLN'), 2);
  assert.equal(decimalsFor('VND'), 0);
  // Zero-decimal currencies Trim cannot be BASED in, but a traveller can spend in.
  assert.equal(decimalsFor('JPY'), 0);
  // Anything unlisted gets the common case rather than throwing.
  assert.equal(decimalsFor('CZK'), 2);
  assert.equal(decimalsFor('ZZZ'), 2);
});

test("converts a foreign amount into the user's own currency", () => {
  // Alex's actual case: a EUR 45 tour, GBP base, ECB rate on 2026-08-10.
  assert.equal(convertToBase({ originalAmount: 45, fxRate: 0.85565, baseCurrency: 'GBP' }), 38.5);
});

test('rounds to the base currency, not the original', () => {
  // 45 * 0.85565 = 38.50425 -> 38.50 for GBP...
  assert.equal(convertToBase({ originalAmount: 45, fxRate: 0.85565, baseCurrency: 'GBP' }), 38.5);
  // ...but a VND-based user gets a whole number, never 38.50 dong.
  assert.equal(
    convertToBase({ originalAmount: 45, fxRate: 29123.4567, baseCurrency: 'VND' }),
    1310556,
  );
});

test('a rate of 1 is a no-op beyond rounding', () => {
  assert.equal(convertToBase({ originalAmount: 12.34, fxRate: 1, baseCurrency: 'GBP' }), 12.34);
});

test('tiny rates do not collapse to zero silently — they round honestly', () => {
  // 50000 VND spent by a GBP user at ~0.0000305. The product is 1.525, and this
  // lands on 1.52, NOT 1.53: toFixed is not round-half-up, because 1.525 is
  // really 1.52499999999999991 in binary. Asserting the true value rather than
  // the arithmetically "expected" one — a half-penny either way is immaterial
  // here, but a test that lies about how rounding works is not.
  assert.equal(
    convertToBase({ originalAmount: 50000, fxRate: 0.0000305, baseCurrency: 'GBP' }),
    1.52,
  );
  // A genuinely sub-penny amount rounds to 0.00 rather than throwing; the route
  // rejects it, but the pure function stays total.
  assert.equal(convertToBase({ originalAmount: 1, fxRate: 0.000001, baseCurrency: 'GBP' }), 0);
});

test('rejects inputs that would produce a nonsense amount', () => {
  for (const bad of [
    { originalAmount: 0, fxRate: 1, baseCurrency: 'GBP' },
    { originalAmount: -5, fxRate: 1, baseCurrency: 'GBP' },
    { originalAmount: 45, fxRate: 0, baseCurrency: 'GBP' },
    { originalAmount: 45, fxRate: -1, baseCurrency: 'GBP' },
    { originalAmount: Number.NaN, fxRate: 1, baseCurrency: 'GBP' },
    { originalAmount: 45, fxRate: Number.POSITIVE_INFINITY, baseCurrency: 'GBP' },
  ]) {
    assert.throws(() => convertToBase(bad), /fx/i, `should have rejected ${JSON.stringify(bad)}`);
  }
});

test('floating point does not leak into the stored figure', () => {
  // 0.1 * 3 style drift must not survive into money.
  const r = convertToBase({ originalAmount: 0.1, fxRate: 3, baseCurrency: 'GBP' });
  assert.equal(r, 0.3);
  assert.equal(String(r), '0.3');
});

test('describeConversion renders the audit line the UI shows', () => {
  assert.equal(
    describeConversion({ originalAmount: 45, originalCurrency: 'EUR', fxRate: 0.85565 }),
    '€45.00 at 0.85565',
  );
  // Falls back to the plain code when there is no symbol for it.
  assert.equal(
    describeConversion({ originalAmount: 200, originalCurrency: 'CZK', fxRate: 0.0338 }),
    'CZK 200.00 at 0.0338',
  );
  // Zero-decimal original.
  assert.equal(
    describeConversion({ originalAmount: 50000, originalCurrency: 'VND', fxRate: 0.0000305 }),
    '₫50000 at 0.0000305',
  );
});
