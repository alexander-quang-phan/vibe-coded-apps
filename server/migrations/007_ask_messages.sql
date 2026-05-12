-- Trim — Ask Trim chat history (Task 6.10).
-- Persists user <-> assistant messages so a returning user can scroll back
-- through prior conversations. Ask Trim is answer-only — no tool use, no DB
-- writes from chat. This table is purely a transcript log.
--
-- Paste into the Supabase SQL editor and run once.

--------------------------------------------------------------------------------
-- 1. ask_messages
--------------------------------------------------------------------------------
do $$ begin
  create type public.ask_message_role as enum ('user', 'assistant');
exception when duplicate_object then null; end $$;

create table if not exists public.ask_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.ask_message_role not null,
  content     text not null check (char_length(content) > 0 and char_length(content) <= 8000),
  created_at  timestamptz not null default now()
);

create index if not exists ask_messages_user_created_idx
  on public.ask_messages (user_id, created_at desc);

--------------------------------------------------------------------------------
-- 2. RLS
--------------------------------------------------------------------------------
alter table public.ask_messages enable row level security;

drop policy if exists "ask_messages_own_select" on public.ask_messages;
drop policy if exists "ask_messages_own_insert" on public.ask_messages;
drop policy if exists "ask_messages_own_delete" on public.ask_messages;

create policy "ask_messages_own_select" on public.ask_messages
  for select using (auth.uid() = user_id);
create policy "ask_messages_own_insert" on public.ask_messages
  for insert with check (auth.uid() = user_id);
create policy "ask_messages_own_delete" on public.ask_messages
  for delete using (auth.uid() = user_id);

--------------------------------------------------------------------------------
-- 3. Data API grants — server-only (browser never touches this table directly)
--------------------------------------------------------------------------------
grant all on table public.ask_messages to service_role;
