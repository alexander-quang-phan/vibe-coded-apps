-- server/migrations/012_encryption_columns.sql
-- Phase 9.5 step 1 of 3: parallel encrypted columns. Plaintext dropped in 013
-- ONLY after encrypt-backfill.mjs verifies round-trips against the database.
--
-- Every add column uses `if not exists` (same style as 005/008) so a partial or
-- repeated apply is a no-op instead of an error. That matters here: this file is
-- pasted into the Supabase SQL editor by hand, and a run that fails halfway
-- through must be safe to re-run without hand-editing the statements out.
alter table public.transactions
  add column if not exists amount_enc text,
  add column if not exists description_enc text;

alter table public.budgets
  add column if not exists amount_limit_enc text;

alter table public.categories
  add column if not exists name_enc text;

alter table public.savings_goals
  add column if not exists name_enc text,
  add column if not exists target_amount_enc text,
  add column if not exists current_amount_enc text;

alter table public.savings_contributions
  add column if not exists amount_enc text,
  add column if not exists note_enc text;

alter table public.subscription_overrides
  add column if not exists display_name_enc text;

alter table public.user_stats
  add column if not exists monthly_limit_enc text;

alter table public.ask_messages
  add column if not exists content_enc text;
