-- Trim — Task 6.12a: manually-marked recurring transactions (schema).
--
-- Migration number note: 013 is reserved in BUILD_PLAN.md's Phase 9 plan for
-- the encryption plaintext-drop (irreversible, gated on Alex's explicit
-- confirmation, and not yet written to disk). Nothing on disk currently uses
-- 013, but taking it here would collide with that documented reservation, so
-- this uses 014 instead — 013 stays free for the encryption work exactly as
-- already written up in BUILD_PLAN.md.
--
-- Paste into the Supabase SQL editor and run once.

create table if not exists public.recurrences (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  category_id  uuid not null references public.categories(id) on delete cascade,
  type         public.transaction_type not null default 'expense',
  amount       numeric not null check (amount > 0),
  description  text,
  interval     text not null check (interval in ('monthly', 'weekly')),
  next_run_at  date not null,
  last_run_at  date,
  cancelled_at timestamptz,
  created_at   timestamptz not null default now()
);

-- Historical transactions must never disappear if a schedule is removed —
-- `set null`, not cascade. (Nothing in this task exposes a hard-delete route
-- for a recurrence; soft-cancel via `cancelled_at` is the only off-ramp. This
-- FK behaviour is a safety net for any future or manual deletion path.)
alter table public.transactions
  add column if not exists recurrence_id uuid references public.recurrences(id) on delete set null;

create index if not exists recurrences_user_id_idx on public.recurrences(user_id);
-- Partial index matches exactly the WHERE clause the cron executor queries
-- with (not cancelled, due today or earlier) — see lib/runRecurrences.js.
create index if not exists recurrences_due_idx
  on public.recurrences(next_run_at) where cancelled_at is null;

alter table public.recurrences enable row level security;

drop policy if exists "recurrences_own_select" on public.recurrences;
drop policy if exists "recurrences_own_insert" on public.recurrences;
drop policy if exists "recurrences_own_update" on public.recurrences;
drop policy if exists "recurrences_own_delete" on public.recurrences;

create policy "recurrences_own_select" on public.recurrences
  for select using (auth.uid() = user_id);
create policy "recurrences_own_insert" on public.recurrences
  for insert with check (auth.uid() = user_id);
create policy "recurrences_own_update" on public.recurrences
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "recurrences_own_delete" on public.recurrences
  for delete using (auth.uid() = user_id);

-- Data API grant — same reasoning as 002_service_role_grants.sql: the Express
-- server queries through Supabase's REST/Data API, which needs the Postgres
-- object grant in addition to RLS. The cron route is the one place that
-- legitimately reads/writes across every user's rows via this same
-- service-role client (see routes/cron.js) — that's a deliberate, documented
-- exception to "scope every query by req.user.id", not a gap.
grant all on table public.recurrences to service_role;
