-- 017b — Phase 18: trips, with a budget per category and per city.
--
-- Spec: docs/superpowers/specs/2026-10-13-trips-design.md
--
-- WHY THE NAME. `019_encryption_drop_plaintext.sql` must sort LAST of all
-- (test/encryptionScope.test.js), so this cannot be 020. `017b` sorts after
-- 017a_subscription_tracking and before 018, whose edits add these tables'
-- encrypted columns. Verified against the live database on 2026-11-03: everything
-- through 017a applied, 012/018/018a/019 NOT applied, no `_enc` column anywhere.
--
-- APPLY THIS BEFORE DEPLOYING THE API THAT SELECTS `trip_id`, or every transaction
-- read and create 500s on the new columns (the Phase 12 lesson).
--
-- Additive only, and every statement is idempotent, so running it twice is safe.

create table if not exists public.trips (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  name                  text not null,
  start_date            date not null,
  end_date              date not null,
  total_budget          numeric(14,2) check (total_budget > 0),
  keep_out_of_monthly   boolean not null default true,
  source_group_id       uuid references public.special_groups(id) on delete set null,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  constraint trips_dates_ordered check (end_date >= start_date)
);

create table if not exists public.trip_stops (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  trip_id     uuid not null references public.trips(id) on delete cascade,
  name        text not null,
  start_date  date not null,
  end_date    date not null,
  budget      numeric(14,2) check (budget > 0),
  currency    text check (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz not null default now(),
  constraint trip_stops_dates_ordered check (end_date >= start_date)
);

create table if not exists public.trip_category_budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  trip_id       uuid not null references public.trips(id) on delete cascade,
  category_id   uuid not null references public.categories(id) on delete cascade,
  amount_limit  numeric(14,2) not null check (amount_limit > 0),
  created_at    timestamptz not null default now(),
  constraint trip_category_budgets_unique unique (trip_id, category_id)
);

-- `set null`, NOT cascade: deleting a trip or a stop must never delete the spending
-- on it. The transactions survive, simply untagged.
alter table public.transactions
  add column if not exists trip_id uuid references public.trips(id) on delete set null,
  -- An explicit city OVERRIDE only. NULL means "derive the city from the date".
  add column if not exists trip_stop_id uuid references public.trip_stops(id) on delete set null;

-- Single-row rules get a database backstop, because the service role bypasses RLS and
-- the test harness enforces no constraints. No existing row has a trip_id, so both hold
-- on creation. `trip_stop_id is null or trip_id is not null` was considered and
-- rejected: the order of two `on delete set null` actions during an account-deletion
-- cascade is not something to bet a migration on. The routes enforce that one.
alter table public.transactions drop constraint if exists transactions_trip_xor_group;
alter table public.transactions
  add constraint transactions_trip_xor_group check (trip_id is null or special_group_id is null);
alter table public.transactions drop constraint if exists transactions_trip_expense_only;
alter table public.transactions
  add constraint transactions_trip_expense_only check (trip_id is null or type = 'expense');

create index if not exists trips_user_id_idx on public.trips(user_id);
create index if not exists trip_stops_user_id_idx on public.trip_stops(user_id);
create index if not exists trip_stops_trip_id_idx on public.trip_stops(trip_id);
create index if not exists trip_category_budgets_user_id_idx on public.trip_category_budgets(user_id);
-- Partial indexes: the vast majority of transactions have no trip, and every query
-- that uses these columns filters on "is not null" or on one id.
create index if not exists transactions_trip_idx
  on public.transactions(trip_id) where trip_id is not null;
create index if not exists transactions_trip_stop_idx
  on public.transactions(trip_stop_id) where trip_stop_id is not null;

alter table public.trips enable row level security;
alter table public.trip_stops enable row level security;
alter table public.trip_category_budgets enable row level security;

drop policy if exists "trips_own_select" on public.trips;
drop policy if exists "trips_own_insert" on public.trips;
drop policy if exists "trips_own_update" on public.trips;
drop policy if exists "trips_own_delete" on public.trips;

create policy "trips_own_select" on public.trips
  for select using (auth.uid() = user_id);
create policy "trips_own_insert" on public.trips
  for insert with check (auth.uid() = user_id);
create policy "trips_own_update" on public.trips
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trips_own_delete" on public.trips
  for delete using (auth.uid() = user_id);

drop policy if exists "trip_stops_own_select" on public.trip_stops;
drop policy if exists "trip_stops_own_insert" on public.trip_stops;
drop policy if exists "trip_stops_own_update" on public.trip_stops;
drop policy if exists "trip_stops_own_delete" on public.trip_stops;

create policy "trip_stops_own_select" on public.trip_stops
  for select using (auth.uid() = user_id);
create policy "trip_stops_own_insert" on public.trip_stops
  for insert with check (auth.uid() = user_id);
create policy "trip_stops_own_update" on public.trip_stops
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trip_stops_own_delete" on public.trip_stops
  for delete using (auth.uid() = user_id);

drop policy if exists "trip_category_budgets_own_select" on public.trip_category_budgets;
drop policy if exists "trip_category_budgets_own_insert" on public.trip_category_budgets;
drop policy if exists "trip_category_budgets_own_update" on public.trip_category_budgets;
drop policy if exists "trip_category_budgets_own_delete" on public.trip_category_budgets;

create policy "trip_category_budgets_own_select" on public.trip_category_budgets
  for select using (auth.uid() = user_id);
create policy "trip_category_budgets_own_insert" on public.trip_category_budgets
  for insert with check (auth.uid() = user_id);
create policy "trip_category_budgets_own_update" on public.trip_category_budgets
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trip_category_budgets_own_delete" on public.trip_category_budgets
  for delete using (auth.uid() = user_id);

-- Data API grants — same reasoning as 002_service_role_grants.sql: the Express server
-- queries through Supabase's REST/Data API, which needs the Postgres object grant in
-- addition to RLS.
grant all on table public.trips to service_role;
grant all on table public.trip_stops to service_role;
grant all on table public.trip_category_budgets to service_role;
