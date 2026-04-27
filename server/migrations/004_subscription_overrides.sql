-- Trim — subscription audit overrides.
-- Detection always runs fresh against the user's transactions; this table only
-- stores the user's audit decision (active vs cancelled) so re-running detection
-- after a new month doesn't lose their cancellations.
--
-- Paste into the Supabase SQL editor and run once.

create table if not exists public.subscription_overrides (
  user_id      uuid not null references auth.users(id) on delete cascade,
  merchant_key text not null,
  status       text not null check (status in ('active', 'cancelled')),
  decided_at   timestamptz not null default now(),
  primary key (user_id, merchant_key)
);

create index if not exists subscription_overrides_user_idx
  on public.subscription_overrides(user_id);

alter table public.subscription_overrides enable row level security;

drop policy if exists "subscription_overrides_own_select" on public.subscription_overrides;
drop policy if exists "subscription_overrides_own_insert" on public.subscription_overrides;
drop policy if exists "subscription_overrides_own_update" on public.subscription_overrides;
drop policy if exists "subscription_overrides_own_delete" on public.subscription_overrides;

create policy "subscription_overrides_own_select" on public.subscription_overrides
  for select using (auth.uid() = user_id);
create policy "subscription_overrides_own_insert" on public.subscription_overrides
  for insert with check (auth.uid() = user_id);
create policy "subscription_overrides_own_update" on public.subscription_overrides
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "subscription_overrides_own_delete" on public.subscription_overrides
  for delete using (auth.uid() = user_id);

grant all on table public.subscription_overrides to service_role;
