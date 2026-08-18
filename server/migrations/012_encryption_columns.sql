-- server/migrations/012_encryption_columns.sql
-- Phase 9.5 step 1 of 3: parallel encrypted columns. Plaintext dropped in 013
-- ONLY after scripts/verify-encryption.mjs passes against the database.
--
-- RE-SCOPED 2026-08-09, before this file had ever been applied anywhere. It is
-- safe to edit rather than supersede: `list_migrations` on the live project
-- shows 008, 009, 010, 011, 014, 015 — 012 has never run.
--
-- SCOPE: encrypt the MONEY, leave the searchable text alone.
--
-- Dropped from the original scope, deliberately:
--   transactions.description   routes/categories.js:89 runs `.ilike()` on this
--                              IN THE DATABASE for merchant memory (Task 6.9).
--                              A ciphertext cannot be ILIKE'd and decrypting
--                              after fetch does not help — encrypting it would
--                              silently break that feature forever.
--   categories.name            lib/categoryKeywords.js matches on it by name.
--   savings_goals.name,
--   savings_contributions.note,
--   subscription_overrides.display_name
--                              Labels, not amounts. Nothing queries them, so
--                              they can be added later at low cost if wanted.
--
-- Added to scope: recurrences.amount. That table (migration 014) did not exist
-- when this file was written, and its nightly cron inserts financial rows.
--
-- Added to scope 2026-08-18: transactions.original_amount. Migration 016
-- (foreign currency) postdated this file by a month, so the column appeared in
-- NO list — not here, not the backfill's JOBS, not the completeness gate. That
-- is not cosmetic: `transactions.amount` is DERIVED as
-- `original_amount * fx_rate`, and both were plaintext, so every foreign-currency
-- expense had its "encrypted" amount recoverable from the dashboard by one
-- multiplication. Encrypting original_amount closes the reconstruction.
--
-- `fx_rate` deliberately STAYS plaintext: it is a public market rate that reveals
-- only which currency pair was used on which day, never how much, and keeping it
-- numeric keeps the `transactions_fx_sane` CHECK (fx_rate > 0) enforceable in the
-- database. See lib/encryptedFields.js, which is now the one list all of this
-- derives from — this file must match it column for column.
--
-- Every add column uses `if not exists` (same style as 005/008) so a partial or
-- repeated apply is a no-op instead of an error. That matters here: this file is
-- pasted into the Supabase SQL editor by hand, and a run that fails halfway
-- through must be safe to re-run without hand-editing the statements out.

alter table public.transactions
  add column if not exists amount_enc text,
  add column if not exists original_amount_enc text;

alter table public.budgets
  add column if not exists amount_limit_enc text;

alter table public.savings_goals
  add column if not exists target_amount_enc text,
  add column if not exists current_amount_enc text;

alter table public.savings_contributions
  add column if not exists amount_enc text;

alter table public.user_stats
  add column if not exists monthly_limit_enc text;

-- Free-form chat content: could contain anything, and nothing queries it.
alter table public.ask_messages
  add column if not exists content_enc text;

-- `recurrences.amount_enc` DELIBERATELY LIVES IN 018, NOT HERE.
-- `public.recurrences` is created by 014_recurrences.sql, which sorts AFTER this
-- file. Altering it here made a fresh filename-order replay of the migrations
-- fail on a table that does not exist yet — invisible on the live database,
-- which had 014 applied long before anyone tried to apply 012, but fatal for
-- anybody rebuilding from scratch. The column is registered in
-- lib/encryptedFields.js exactly as before; only the file it is created in moved.
-- test/encryptionScope.test.js now fails the build if ANY migration alters a
-- table an earlier-sorting migration has not created.
-- [Codex stage-5 RE-VERIFY #2 finding 3, 2026-08-18]
