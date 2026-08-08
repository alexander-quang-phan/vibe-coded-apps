-- Trim — Phase 10 B1: special-expense groups.
--
-- Lets a special expense optionally belong to a named pot ("September 2026
-- Paris holiday") so its running total can be read in one place. Grouping is
-- OPTIONAL throughout: a special expense with no group behaves exactly as it
-- did before this migration, and nothing here touches budget math — special
-- expenses already leave budget math via server/lib/special.js.
--
-- Paste into the Supabase SQL editor and run once. Additive only.

create table if not exists public.special_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

-- `set null`, NOT cascade: deleting a group must never delete the spending it
-- grouped. The transactions survive, simply ungrouped.
alter table public.transactions
  add column if not exists special_group_id uuid
    references public.special_groups(id) on delete set null;

create index if not exists special_groups_user_id_idx on public.special_groups(user_id);
-- Partial index — the vast majority of transactions have no group, and every
-- query that uses this column filters on "is not null".
create index if not exists transactions_special_group_idx
  on public.transactions(special_group_id) where special_group_id is not null;

alter table public.special_groups enable row level security;

drop policy if exists "special_groups_own_select" on public.special_groups;
drop policy if exists "special_groups_own_insert" on public.special_groups;
drop policy if exists "special_groups_own_update" on public.special_groups;
drop policy if exists "special_groups_own_delete" on public.special_groups;

create policy "special_groups_own_select" on public.special_groups
  for select using (auth.uid() = user_id);
create policy "special_groups_own_insert" on public.special_groups
  for insert with check (auth.uid() = user_id);
create policy "special_groups_own_update" on public.special_groups
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "special_groups_own_delete" on public.special_groups
  for delete using (auth.uid() = user_id);

-- Data API grant — same reasoning as 002_service_role_grants.sql: the Express
-- server queries through Supabase's REST/Data API, which needs the Postgres
-- object grant in addition to RLS.
grant all on table public.special_groups to service_role;
