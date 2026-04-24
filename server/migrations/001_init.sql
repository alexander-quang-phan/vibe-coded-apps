-- Trim — initial schema, RLS, and signup trigger.
-- Paste this whole file into the Supabase SQL editor and run once.
-- Safe to re-run: every object uses `if not exists` or drop-first.

--------------------------------------------------------------------------------
-- 1. Enums
--------------------------------------------------------------------------------
do $$ begin
  create type public.transaction_type as enum ('income', 'expense');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.budget_period as enum ('monthly', 'weekly');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.currency_code as enum ('GBP', 'USD', 'AUD', 'VND');
exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- 2. user_stats — 1:1 with auth.users, stores game + preferences
--------------------------------------------------------------------------------
create table if not exists public.user_stats (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  currency          public.currency_code not null default 'GBP',
  simple_mode       boolean not null default false,
  display_name      text,
  current_streak    int not null default 0,
  longest_streak    int not null default 0,
  shields           int not null default 0,
  last_logged_date  date,
  xp_points         int not null default 0,
  level             int not null default 1,
  badges            jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

--------------------------------------------------------------------------------
-- 3. categories
--------------------------------------------------------------------------------
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  icon        text not null default '📦',
  color       text not null default '#64748b',
  type        public.transaction_type not null default 'expense',
  is_default  boolean not null default false,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists categories_user_id_idx on public.categories(user_id);

--------------------------------------------------------------------------------
-- 4. transactions
--------------------------------------------------------------------------------
create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  category_id     uuid references public.categories(id) on delete set null,
  amount          numeric(14, 2) not null check (amount > 0),
  type            public.transaction_type not null,
  description     text,
  date            date not null default current_date,
  is_recurring    boolean not null default false,
  recurrence_rule text,
  created_at      timestamptz not null default now()
);
create index if not exists transactions_user_date_idx on public.transactions(user_id, date desc);
create index if not exists transactions_user_cat_idx  on public.transactions(user_id, category_id);

--------------------------------------------------------------------------------
-- 5. budgets
--------------------------------------------------------------------------------
create table if not exists public.budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  category_id   uuid not null references public.categories(id) on delete cascade,
  amount_limit  numeric(14, 2) not null check (amount_limit > 0),
  period        public.budget_period not null default 'monthly',
  created_at    timestamptz not null default now(),
  unique (user_id, category_id, period)
);
create index if not exists budgets_user_idx on public.budgets(user_id);

--------------------------------------------------------------------------------
-- 6. savings_goals + contributions
--------------------------------------------------------------------------------
create table if not exists public.savings_goals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  emoji           text not null default '🎯',
  target_amount   numeric(14, 2) not null check (target_amount > 0),
  target_date     date,
  current_amount  numeric(14, 2) not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists savings_goals_user_idx on public.savings_goals(user_id);

create table if not exists public.savings_contributions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  goal_id     uuid not null references public.savings_goals(id) on delete cascade,
  amount      numeric(14, 2) not null check (amount > 0),
  date        date not null default current_date,
  created_at  timestamptz not null default now()
);
create index if not exists savings_contributions_goal_idx on public.savings_contributions(goal_id);

--------------------------------------------------------------------------------
-- 7. Row Level Security
-- All tables: users can only read/write rows where user_id = auth.uid().
-- Service-role key bypasses RLS, but our Express API always scopes queries
-- to req.user.id — RLS is defence-in-depth.
--------------------------------------------------------------------------------
alter table public.user_stats             enable row level security;
alter table public.categories             enable row level security;
alter table public.transactions           enable row level security;
alter table public.budgets                enable row level security;
alter table public.savings_goals          enable row level security;
alter table public.savings_contributions  enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'user_stats', 'categories', 'transactions',
    'budgets', 'savings_goals', 'savings_contributions'
  ] loop
    execute format('drop policy if exists "%s_own_select" on public.%I', t, t);
    execute format('drop policy if exists "%s_own_insert" on public.%I', t, t);
    execute format('drop policy if exists "%s_own_update" on public.%I', t, t);
    execute format('drop policy if exists "%s_own_delete" on public.%I', t, t);

    if t = 'user_stats' then
      execute format(
        'create policy "%s_own_select" on public.%I for select using (auth.uid() = user_id)', t, t);
      execute format(
        'create policy "%s_own_update" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t, t);
    else
      execute format(
        'create policy "%s_own_select" on public.%I for select using (auth.uid() = user_id)', t, t);
      execute format(
        'create policy "%s_own_insert" on public.%I for insert with check (auth.uid() = user_id)', t, t);
      execute format(
        'create policy "%s_own_update" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t, t);
      execute format(
        'create policy "%s_own_delete" on public.%I for delete using (auth.uid() = user_id)', t, t);
    end if;
  end loop;
end $$;

--------------------------------------------------------------------------------
-- 8. New-user trigger — seed user_stats + default categories on signup
--------------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_stats (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.categories (user_id, name, icon, color, type, is_default, sort_order)
  values
    (new.id, 'Food',          '🍔', '#f97316', 'expense', true, 1),
    (new.id, 'Transport',     '🚗', '#3b82f6', 'expense', true, 2),
    (new.id, 'Rent',          '🏠', '#8b5cf6', 'expense', true, 3),
    (new.id, 'Bills',         '💡', '#ec4899', 'expense', true, 4),
    (new.id, 'Groceries',     '🛒', '#84cc16', 'expense', true, 5),
    (new.id, 'Entertainment', '🎬', '#f59e0b', 'expense', true, 6),
    (new.id, 'Shopping',      '🛍️', '#06b6d4', 'expense', true, 7),
    (new.id, 'Health',        '💊', '#10b981', 'expense', true, 8),
    (new.id, 'Other',         '📦', '#64748b', 'expense', true, 9),
    (new.id, 'Salary',        '💼', '#22c55e', 'income',  true, 10),
    (new.id, 'Freelance',     '💻', '#14b8a6', 'income',  true, 11),
    (new.id, 'Other Income',  '💰', '#eab308', 'income',  true, 12)
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

--------------------------------------------------------------------------------
-- 9. Data API grants
-- Supabase's REST/Data API still needs normal Postgres object privileges before
-- RLS or service-role bypass can apply. We grant only the server-side service_role
-- because Trim's browser client never reads/writes app data directly.
--------------------------------------------------------------------------------
grant usage on schema public to service_role;
grant all on table
  public.user_stats,
  public.categories,
  public.transactions,
  public.budgets,
  public.savings_goals,
  public.savings_contributions
to service_role;
grant all on all routines in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant all on routines to service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to service_role;
