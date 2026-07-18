-- server/migrations/012_encryption_columns.sql
-- Phase 9.5 step 1 of 3: parallel encrypted columns. Plaintext dropped in 013
-- ONLY after encrypt-backfill.mjs verifies round-trips.
alter table public.transactions          add column amount_enc text, add column description_enc text;
alter table public.budgets               add column amount_limit_enc text;
alter table public.categories            add column name_enc text;
alter table public.savings_goals         add column name_enc text, add column target_amount_enc text, add column current_amount_enc text;
alter table public.savings_contributions add column amount_enc text, add column note_enc text;
alter table public.subscription_overrides add column display_name_enc text;
alter table public.user_stats            add column monthly_limit_enc text;
alter table public.ask_messages          add column content_enc text;
