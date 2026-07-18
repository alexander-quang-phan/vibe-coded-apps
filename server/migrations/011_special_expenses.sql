-- server/migrations/011_special_expenses.sql
-- Phase 9.2: opt-in special expenses (outside the monthly budget).
alter table public.transactions
  add column is_special boolean not null default false;
alter table public.user_stats
  add column special_expenses_enabled boolean not null default false;
