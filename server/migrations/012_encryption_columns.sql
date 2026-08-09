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
-- Every add column uses `if not exists` (same style as 005/008) so a partial or
-- repeated apply is a no-op instead of an error. That matters here: this file is
-- pasted into the Supabase SQL editor by hand, and a run that fails halfway
-- through must be safe to re-run without hand-editing the statements out.

alter table public.transactions
  add column if not exists amount_enc text;

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

-- Task 6.12's recurring schedules carry the same financial data as transactions.
alter table public.recurrences
  add column if not exists amount_enc text;
