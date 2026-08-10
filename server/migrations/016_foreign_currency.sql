-- Trim — Phase 12: log an expense in a foreign currency.
--
-- Alex lives on GBP but is travelling to France and Italy, so some expenses are
-- paid in EUR. The rule chosen for this (see
-- docs/superpowers/specs/2026-08-10-multi-currency-design.md) is CONVERT AT
-- ENTRY: `transactions.amount` stays in the user's own default currency, exactly
-- as every row in the table already is, and the foreign original is recorded
-- alongside it purely so the UI can show "you paid €45.00".
--
-- That choice is what makes this migration additive and safe. Every total,
-- budget, average, projection and affordability check in the app keeps summing
-- one number in one currency and needs no change whatsoever. Nothing here alters
-- an existing column or backfills a row.
--
-- All three columns are NULL for a same-currency transaction, which is every
-- row that exists today and the large majority of rows that ever will. NULL
-- means "paid in the user's own currency" — there is no sentinel to interpret.
--
-- Paste into the Supabase SQL editor and run once. Additive only.

alter table public.transactions
  -- What the user actually typed, in the currency they typed it in.
  add column if not exists original_amount   numeric(14, 2),
  -- ISO 4217, uppercase. Not an enum: the set of currencies a user may SPEND in
  -- while travelling is much larger than the five Trim can be *based* in, and it
  -- tracks whatever the rate provider covers rather than our own settings list.
  add column if not exists original_currency text,
  -- Units of the user's currency per 1 unit of original_currency, at entry time.
  -- Stored so a row can always be re-explained ("€45.00 at 0.85565") without
  -- re-fetching a rate that has since moved. 8dp because some pairs are tiny.
  add column if not exists fx_rate           numeric(18, 8);

-- The three are meaningful only together: a rate with no currency, or an amount
-- with no rate, would leave a row that cannot be explained or recomputed. Either
-- all three are present or all three are NULL.
alter table public.transactions
  drop constraint if exists transactions_fx_all_or_nothing;
alter table public.transactions
  add constraint transactions_fx_all_or_nothing check (
    (original_amount is null and original_currency is null and fx_rate is null)
    or (original_amount is not null and original_currency is not null and fx_rate is not null)
  );

-- Shape and sanity. A zero or negative rate would silently zero out the
-- converted amount; a lowercase or padded code would break display lookups.
alter table public.transactions
  drop constraint if exists transactions_fx_sane;
alter table public.transactions
  add constraint transactions_fx_sane check (
    (original_currency is null or original_currency ~ '^[A-Z]{3}$')
    and (original_amount is null or original_amount > 0)
    and (fx_rate is null or fx_rate > 0)
  );

-- No new RLS policy is needed: these are columns on `transactions`, which is
-- already covered by its existing per-user policies. No index either — nothing
-- filters or sorts on them; they are read only alongside the row itself.
