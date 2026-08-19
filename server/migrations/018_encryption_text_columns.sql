-- server/migrations/018_encryption_text_columns.sql
-- Phase 9.5 — scope expansion: encrypt the free TEXT too, not just the money.
--
-- Additive and re-runnable, exactly like 012. Apply it in the same step as 012;
-- neither has ever been applied to any database. Nothing here alters or drops
-- an existing column, and every statement is `if not exists`, so a run that
-- fails halfway is safe to re-run.
--
-- WHY (Alex, 2026-08-18): encrypting only amounts left the Supabase dashboard
-- showing WHAT everyone bought — "Boots", "Pharmacy", a therapist's name — while
-- hiding only how much. For the stated goal ("so I can't see other people's
-- transactions and other private information") the descriptions are arguably the
-- private part.
--
-- The hard part is that `transactions.description` was searched IN THE DATABASE:
-- routes/categories.js ran `.ilike('description', '%term%')` to answer "what did
-- you file this merchant under last time?" (Task 6.9, the suggested-category chip
-- in Quick Add). You cannot ILIKE a ciphertext. So each row also carries a BLIND
-- INDEX — a per-user keyed HMAC of the normalised merchant — and the lookup
-- hashes the search term the same way and matches on equality.
--
-- What a blind index costs, stated honestly: it is deterministic, so anyone
-- reading the table can see which rows share a merchant and how many there are —
-- for merchant_prefix_hmacs, which rows share their first 2-8 normalised
-- characters. They cannot see WHICH merchant. The key is per-user, so the same shop under two
-- users hashes differently and a leaked backup cannot be correlated across
-- people. See blindIndex() in lib/crypto.js.
--
-- STILL PLAINTEXT ON PURPOSE:
--   transactions.fx_rate  a public market rate; keeping it numeric keeps the
--                     `fx_rate > 0` CHECK enforceable.
--
-- CORRECTED 2026-08-18 (Codex stage-4 VERIFY): categories.name was listed here
-- as safe "because it is only the 12 seeded defaults". That was wrong.
-- routes/categories.js:127 accepts any name a user posts (40 chars, is_default
-- false) and :159 renames existing ones, so a category can be "Therapy" or
-- "Divorce lawyer". It is now encrypted, with a blind index for the exact
-- `.eq('name', …)` keyword lookup.
--
-- lib/encryptedFields.js is the source of truth for all of this, and
-- test/encryptionScope.test.js fails the build if this file drifts from it.

-- --- free text -------------------------------------------------------------

alter table public.transactions
  add column if not exists description_enc text,
  -- Blind index for merchant memory. Merchant memory is a TYPEAHEAD —
  -- QuickAddDialog.jsx fires /suggest on every keystroke from the second
  -- character — and the old `.ilike('description', '%term%')` matched partial
  -- words naturally. An exact-match hash would light the category chip only once
  -- the merchant was typed out in full, so this holds a hash of EVERY prefix of
  -- the normalised merchant and the read path hashes what has been typed so far.
  --
  -- Prefixes are CAPPED AT 8 CHARACTERS on both sides (MAX_PREFIX in
  -- lib/merchant.js). At 24 this column published a per-user prefix TRIE: the
  -- exact longest common prefix of any two rows, the strict-prefix families, and
  -- every merchant's exact normalised length. At 8 the trie is bounded and the
  -- length leak saturates — a query longer than the cap matches a superset here
  -- and is then re-tested exactly against the decrypted description on the
  -- server. [Codex stage-4 RE-VERIFY findings 3 and 4, 2026-08-18]
  add column if not exists merchant_prefix_hmacs text[];

-- The nightly cron (lib/runRecurrences.js) copies this into a real transaction,
-- so leaving it readable would leak every recurring merchant anyway.
--
-- `amount_enc` is here rather than in 012 because `public.recurrences` is created
-- by 014, which sorts AFTER 012 — so creating it there broke a fresh replay of
-- the migrations in filename order. This file sorts after 014, so both columns
-- can be created together. [Codex stage-5 RE-VERIFY #2 finding 3, 2026-08-18]
alter table public.recurrences
  add column if not exists description_enc text,
  add column if not exists amount_enc text;

-- Labels. Verified 2026-08-18 that NOTHING queries these in the database —
-- goals and special groups are ordered by created_at, never by name.
alter table public.savings_goals
  add column if not exists name_enc text;

alter table public.savings_contributions
  add column if not exists note_enc text;

alter table public.special_groups
  add column if not exists name_enc text;

alter table public.categories
  add column if not exists name_enc text,
  -- Exact-match blind index for the keyword lookup at routes/categories.js:112.
  add column if not exists name_hmac text;

alter table public.subscription_overrides
  add column if not exists display_name_enc text,
  -- An ENCRYPTED copy of the merchant key, not just the hash. A hash is one-way:
  -- once the plaintext merchant_key is dropped, a master-key rotation (which
  -- changes the index key) could never recompute the hash, and this table's
  -- primary key would be unrebuildable. Decrypt under the old key, re-hash under
  -- the new one. [Codex stage-4 VERIFY, 2026-08-18]
  add column if not exists merchant_key_enc text,
  -- `merchant_key` is the PRIMARY KEY and holds either the normalised merchant
  -- ("netflix") or a synthetic key embedding an amount bucket
  -- ("auto:<category>:25:monthly") — so it leaks both the merchant AND roughly
  -- what it costs, in a column no amount encryption ever touched. This is its
  -- blind-index replacement; migration 019 moves the primary key onto it.
  add column if not exists merchant_key_hmac text;

-- --- indexes for the blind-index lookups ------------------------------------
-- Merchant memory runs on every keystroke-ish in Quick Add, so these matter.
-- Scoped by user_id because every lookup is already `.eq('user_id', …)`.

-- GIN so `merchant_prefix_hmacs @> ARRAY[<typed prefix hash>]` is an index scan.
-- This runs on every keystroke in Quick Add, so it matters.
create index if not exists transactions_merchant_prefix_hmacs_idx
  on public.transactions using gin (merchant_prefix_hmacs);

create index if not exists transactions_user_idx
  on public.transactions (user_id);

-- Uniqueness is what lets migration 019 promote this to the primary key. If this
-- CREATE fails with a duplicate-key error, two different merchant keys hashed to
-- the same value for one user — stop and investigate before going further.
create unique index if not exists subscription_overrides_user_key_hmac_idx
  on public.subscription_overrides (user_id, merchant_key_hmac);

create index if not exists categories_user_name_hmac_idx
  on public.categories (user_id, name_hmac);

-- Makes the default-category seeding atomic once it moves out of the signup
-- trigger. Migration 019 must replace handle_new_user() before it drops
-- categories.name (the database has no encryption key and cannot write
-- name_enc), so seeding moves to GET /api/me — and a route can be called twice
-- at once, where an AFTER INSERT trigger could not. Without this index, two tabs
-- opening a brand-new account race and produce 24 default categories.
-- lib/defaultCategories.js catches the resulting 23505 and treats it as
-- "already seeded", which is what the trigger's atomicity gave for free.
--
-- PARTIAL, on purpose: user-created categories are `is_default = false` and all
-- carry sort_order 0 (001_init line 49), so a non-partial index would forbid a
-- user having more than one custom category.
--
-- If this CREATE fails with a duplicate-key error, some user already has two
-- default categories in the same slot — stop and clean that up first.
-- [Codex stage-4 RE-VERIFY finding 5, 2026-08-18]
create unique index if not exists categories_user_default_slot_idx
  on public.categories (user_id, sort_order)
  where is_default;
