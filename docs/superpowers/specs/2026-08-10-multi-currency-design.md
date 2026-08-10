# Foreign-currency expenses — design

**Date:** 2026-08-10
**Status:** built and verified; awaiting migration 016 + deploy
**Scope:** one migration, one pure lib, one new route, a currency control in Quick Add, and a
second line on transaction rows.

## The ask

> "I want a feature where I can add expenses in multiple different currencies at once or have it
> exchanged to one currency […] I live in London right now but I'm going on a trip to France and
> Italy soon so I just made an expense booking a tour in euros"

Followed by: **"make sure that it converts to whichever default currency the user has the app in"** —
so the target is `user_stats.currency`, never a hard-coded GBP.

## The rule

**Convert at entry. `transactions.amount` is always in the user's own default currency.**

The foreign original is recorded beside it — amount, currency, and the rate used — purely so the UI
can say "you paid €45.00" and so the row can be re-explained later without re-fetching a rate that
has since moved.

Alex chose this over storing the foreign amount and converting on read. The reason is blast radius:
every total, budget, average, projection, affordability check and Ask Trim context in this app sums
one number in one currency. Converting on read would put a conversion step inside all of them, in a
codebase that has already had two screens disagree about the same figure once
(`projections.js` vs `affordability.js`, fixed by `overallBudget.js`). Convert-at-entry leaves all
of that code untouched, which is why this feature needs no changes to any of it.

## Decisions and their reasons

| Decision | Chosen | Why |
|---|---|---|
| Conversion target | `user_stats.currency`, read server-side | Alex's explicit instruction. Never assume GBP. |
| Who computes the stored amount | **The server**, from original × rate | The client sends the original and the rate; the server derives `amount` and **ignores** whatever `amount` the client sent. Two places computing one figure is exactly how the earlier bug happened. |
| Rate source | Frankfurter (ECB daily), free, no API key | No account to expire, no key to leak, no bill. |
| Unquotable pairs | First-class manual entry, not an error | Verified: Frankfurter publishes 30 currencies and **does not cover VND**, which is one of Trim's five base currencies. A VND-based user could otherwise never convert anything. |
| Rate editability | Always editable, not only on failure | ECB's reference rate is not what a card actually charges. Alex may want the real figure off his statement. |
| Rounding | To the **base** currency's precision | A VND-based user must never end up holding 38.50 dong. |
| Same-currency entries | Stored as ordinary rows, unannotated | Avoids a pointless "GBP 10 at 1.0" on every domestic expense. |

## Components

### `server/migrations/016_foreign_currency.sql`
Three nullable columns on `transactions`: `original_amount`, `original_currency`, `fx_rate`.
NULL means "paid in the user's own currency" — which is every row that exists today, so there is no
backfill and no sentinel to interpret. Two check constraints: all three present or all three NULL,
and shape/sanity (uppercase ISO code, positive amount, positive rate). No new RLS policy — these are
columns on a table already covered — and no index, since nothing filters or sorts on them.

### `server/lib/fx.js` (+ `server/test/fx.test.js`, 8 tests)
`decimalsFor`, `convertToBase`, `describeConversion`. Pure, no I/O. Rounds to the base currency.
Rejects a non-positive or non-finite amount or rate rather than silently storing a zero.

One test documents a real rounding subtlety: `50000 × 0.0000305` is `1.525`, and `.toFixed(2)`
returns **1.52**, not 1.53, because 1.525 is really 1.52499999999999991 in binary. The test asserts
the true value — a test that lies about how rounding works is worse than no test.

### `server/routes/fx.js` — `GET /api/fx?from=EUR&to=GBP`
Returns `{rate, date, source}`, or `{rate: null, reason}` when the pair cannot be quoted.
`reason` is one of `unsupported-pair`, `unreachable`, `provider-error`. Same-currency short-circuits
to `1` without a network call. Rates are cached in-process per day (ECB publishes once a working
day); a cold start simply re-fetches. 4-second abort so a slow third party never holds a request
open while the user is mid-typing. **A missing rate is a 200, not a 500** — the client has a manual
path and this is a normal outcome.

### `POST /api/transactions`
Optional `foreign: {originalAmount, originalCurrency, fxRate}`. When present the server reads the
user's base currency from `user_stats`, derives the stored amount, and rejects the entry if it
converts to zero. When `originalCurrency` equals the base currency it is stored as an ordinary row.
A recurring schedule created from a foreign entry stores the **converted** amount — every
transaction it generates later is an ordinary base-currency row, with the rate frozen at creation.

### Client
`client/src/lib/fx.js` (preview only — the server remains authoritative),
`client/src/components/CurrencyEntry.jsx` (the picker and the conversion panel), the amount row in
`QuickAddDialog`, and a second line on rows in `Transactions` and `RecentTransactions`.

The picker defaults to the user's own currency and renders as a quiet chip, so the two-tap path is
untouched for anyone not travelling. The conversion panel appears only when the entry currency
differs from the base.

## Verified

Against the mock API:
- `EUR→GBP` returns 0.85565; `GBP→GBP` short-circuits to 1; `VND→GBP` returns `rate: null`.
- Posting `€45 @ 0.85565` **with a deliberately wrong client `amount` of 999** stores **38.50** —
  the server ignored the client's figure. Lowercase `"eur"` was upper-cased to `EUR`.
- A same-currency `foreign` block stores an ordinary row with `original_currency: null`.
- The dashboard month total folds the £38.50 in as GBP, unchanged in shape.

In a browser, against the real component:
- Picker defaults to GBP with 31 options; no conversion UI until the currency is changed.
- Switching to EUR auto-fetches the rate and shows "Logs as £38.50"; the amount field's symbol
  becomes €.
- Switching to an unquotable pair shows "No rate available for SEK/GBP — type the rate you were
  charged", empties the rate box, and shows "Enter an amount and a rate".
- Typing a rate by hand (0.075) gives "Logs as £3.38".
- Switching back to GBP removes the panel entirely.

**One bug found and fixed during that pass:** switching EUR → SEK left the euro rate in the box, so
the warning "No rate available" appeared beside "Logs as £38.50" — a figure computed at the wrong
currency's rate. The rate is now cleared the moment the lookup starts.

## Not done

- **Editing** a transaction's currency after the fact. `PATCH` does not accept `foreign`; the row
  keeps whatever it was created with. Editing the amount edits the stored base-currency figure.
- Re-rating historical rows if a rate is later found to be wrong.
- Showing the app's totals in any currency other than the user's own.
- A currency on income, budgets or savings goals. Expenses only, which is what was asked for.
