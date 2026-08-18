-- server/migrations/018a_encryption_write_barrier.sql
-- Phase 9.5 — the ENFORCED write barrier for the irreversible cutover window.
--
-- Numbered 018a so it sorts AFTER 018 and BEFORE 019. Apply it with 012 and 018.
-- It is additive, re-runnable and INERT until someone engages it.
--
-- WHY THIS EXISTS  [Codex stage-4 RE-VERIFY finding 2, 2026-08-18]
-- ----------------------------------------------------------------------------
-- scripts/verify-encryption.mjs used to argue that reading every row twice and
-- comparing a digest proved the database had not moved. It does not, and Codex
-- reproduced why. With 600 valid rows the second pass read page 1, and only then
-- did a concurrent writer delete an already-read row and insert a new
-- plaintext-only row whose primary key sorted INSIDE that page. Page 2 was
-- untouched, so the row stream and the digest matched pass one exactly, the count
-- stayed at 600, and the new unencrypted row was never read by either pass. The
-- gate printed PASS over data migration 019 would then have destroyed.
--
-- That is not a bug in the paging. It is a property of the method: a finite
-- sequence of INDEPENDENT offset-paged HTTP reads can never prove quiescence,
-- because every pair of reads has a gap a writer can use. No third pass fixes it.
--
-- So quiescence stops being something the gate infers and becomes something the
-- DATABASE enforces.
--
-- WHY `FOR SHARE`, AND NOT A PLAIN READ  [Codex stage-5 RE-VERIFY #2 finding 1]
-- ----------------------------------------------------------------------------
-- The first version of this file checked the flag with a plain SELECT. That
-- leaves a Critical hole, which was reproduced on real PostgreSQL 18.4:
--
--   T1: BEGIN; INSERT a plaintext-only row.        -- admitted, engaged = false
--       (stays open, uncommitted)
--   T2: UPDATE encryption_cutover SET engaged = true;   -- returns IMMEDIATELY
--   gate: sees engaged = true, sees 0 rows (T1 is uncommitted and invisible),
--         sees pg_stat unchanged (cumulative stats exclude in-progress work and
--         are explicitly allowed to lag) ... and returns PASS.
--   T1: COMMIT;      -- COMMIT does NOT re-fire the statement trigger
--   019: waits for T1's lock, then drops the plaintext it just committed.
--
-- Measured, before and after:
--   plain SELECT   -> engage returned immediately, gate saw engaged=true and 0
--                     rows => WOULD PASS, then 1 plaintext row committed.
--   SELECT ... FOR SHARE -> engage was still BLOCKED when the gate ran, so the
--                     gate saw engaged=false and failed closed. Window CLOSED.
--
-- The mechanism: every admitted writer takes a SHARE lock on the singleton flag
-- row and holds it until its transaction ends. Engaging the barrier is an UPDATE
-- of that row, which needs the exclusive row lock, so it BLOCKS until every
-- already-admitted writer has finished — it DRAINS them. Any writer that arrives
-- afterwards blocks on the engaging transaction instead, and then sees
-- engaged = true and is rejected. There is no in-between state.
--
-- SHARE locks do not conflict with each other, so ordinary concurrent writes are
-- not serialised against one another; only the once-per-cutover UPDATE waits.
--
-- **`update ... set engaged = true` HANGING IS THE FEATURE.** It means something
-- is still writing. Find it with:
--     select pid, state, xact_start, query from pg_stat_activity
--      where state <> 'idle' and pid <> pg_backend_pid() order by xact_start;
--
-- HOW TO USE IT (this is step 6 of the rollout in SECURITY.md)
-- ----------------------------------------------------------------------------
--   1. Disable the 03:00 recurrences cron in vercel.json / the Vercel dashboard.
--   2. ENGAGE — and wait for it to RETURN, which is the drain completing:
--        update public.encryption_cutover set engaged = true, engaged_at = now();
--      Trim now returns errors on every write. That is the point: a five-user app
--      being briefly unwritable is cheaper than one row of silent data loss.
--   3. cd server && node scripts/verify-encryption.mjs   (must exit 0)
--   4. Take a fresh backup.
--   5. Run 019_encryption_drop_plaintext.sql.
--   6. RELEASE:
--        update public.encryption_cutover set engaged = false, engaged_at = null;
--   7. Re-enable the cron.
--
-- If the gate FAILS you must release the barrier before re-running the backfill —
-- the backfill writes, so it is blocked too, deliberately. Re-engage afterwards.
--
-- ROLLBACK / REMOVAL once the cutover is finished for good:
--   drop function if exists public.encryption_write_counters();
--   -- then, per table: drop trigger if exists <table>_encryption_cutover_guard on public.<table>;
--   drop function if exists public.reject_writes_during_cutover() cascade;
--   drop table if exists public.encryption_cutover;

begin;

-- --- the flag ---------------------------------------------------------------
-- Single row, enforced by a boolean primary key that can only ever be `true`.
-- A second row would let the barrier be "engaged" and "released" at once.
create table if not exists public.encryption_cutover (
  id          boolean primary key default true,
  engaged     boolean not null default false,
  engaged_at  timestamptz,
  note        text,
  constraint encryption_cutover_singleton check (id)
);

insert into public.encryption_cutover (id, engaged, note)
values (true, false, 'Phase 9.5 cutover barrier. Engage only for the migration 019 window.')
on conflict (id) do nothing;

-- The flag table itself carries no trigger, so releasing the barrier is always
-- possible even while it is engaged.
alter table public.encryption_cutover enable row level security;
grant select, update on public.encryption_cutover to service_role;

-- --- the barrier ------------------------------------------------------------
-- STATEMENT level, not row level: this blocks whole statements rather than
-- filtering rows, so it costs one indexed lookup per write statement instead of
-- one per row. When disengaged that is the entire overhead.
--
-- SECURITY DEFINER so the flag is readable whatever role is writing. RLS is on
-- for `encryption_cutover`, and a SECURITY INVOKER function running as a role
-- that neither bypasses RLS nor has a policy would read ZERO rows, leave
-- `is_engaged` NULL, and wave the write through — a barrier that silently does
-- nothing. Execute is revoked below, per migration 009 (Supabase advisor
-- 0028/0029), because this only ever runs from a trigger.
create or replace function public.reject_writes_during_cutover()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_engaged boolean;
begin
  -- FOR SHARE is the entire mechanism; a plain SELECT here is a Critical bug.
  -- It makes this writer hold a share lock on the flag row until its transaction
  -- ends, so the UPDATE that engages the barrier cannot complete until every
  -- already-admitted writer has committed or rolled back.
  select engaged into is_engaged
    from public.encryption_cutover
   where id = true
     for share;

  -- No flag row at all: allow the write. Refusing here would take the whole app
  -- down if the row were ever deleted, and the gate already fails CLOSED on an
  -- unreadable or missing barrier, which is where that must be caught.
  if is_engaged then
    raise exception
      using errcode = '25006', -- read_only_sql_transaction
            message = 'Trim is in the Phase 9.5 encryption cutover window; writes are blocked',
            hint = 'Release it with: update public.encryption_cutover set engaged = false, engaged_at = null;';
  end if;
  return null; -- ignored for statement-level triggers
end;
$$;

revoke execute on function public.reject_writes_during_cutover() from anon, authenticated, public;

-- Every table that holds an encrypted column, i.e. every table migration 019
-- touches. Kept in step with lib/encryptedFields.js by
-- test/encryptionScope.test.js, which fails the build if a registered table has
-- no barrier here.
--
-- TRUNCATE is a SEPARATE trigger event in PostgreSQL — a trigger listing only
-- INSERT/UPDATE/DELETE does not fire for it, and the pg_stat counters the gate
-- reads sum only tuple insert/update/delete, so TRUNCATE would not have shown up
-- there either. It emptied a table straight through the barrier.
-- [Codex stage-5 RE-VERIFY #2 finding 2, 2026-08-18]
do $$
declare
  t text;
  guarded text[] := array[
    'transactions',
    'budgets',
    'savings_goals',
    'savings_contributions',
    'user_stats',
    'ask_messages',
    'recurrences',
    'special_groups',
    'subscription_overrides',
    'categories'
  ];
begin
  foreach t in array guarded loop
    execute format('drop trigger if exists %I on public.%I', t || '_encryption_cutover_guard', t);
    execute format(
      'create trigger %I before insert or update or delete or truncate on public.%I '
      || 'for each statement execute function public.reject_writes_during_cutover()',
      t || '_encryption_cutover_guard', t);
  end loop;
end $$;

-- --- stop the signup trigger seeding plaintext category names ----------------
--
-- This USED to live in 019. That was too late.  [Codex stage-5 RE-VERIFY #2
-- finding 4, 2026-08-18]
--
-- The rollout sets ENCRYPTION_PHASE=dual after this migration, and the whole
-- point of `dual` is that EVERY write writes both the plaintext and the
-- ciphertext. But migration 001's `handle_new_user()` inserts twelve categories
-- with `name` only, and it runs inside the auth.users INSERT where no API code
-- can reach. `ensureDefaultCategories()` would then see categories already
-- present and return without filling `name_enc`/`name_hmac`, so every account
-- created during the dual window carried plaintext-only category names. The gate
-- fails closed on those, which is correct but means the cutover simply cannot
-- proceed until they are repaired.
--
-- Seeding cannot stay in the database: it has no DATA_ENCRYPTION_KEY and cannot
-- write `name_enc`. So it moves to the API here, at the START of the window
-- rather than at the end — `server/lib/defaultCategories.js`, called from
-- `GET /api/me` AND `GET /api/categories`, idempotent, and phase-aware. In the
-- `off` phase it writes exactly the columns it always did, so applying this
-- migration on its own changes nothing observable.
--
-- user_stats seeding STAYS here: it writes no encrypted column, and GET /api/me
-- has its own fallback insert for it.
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

  -- Default categories are seeded by the API (lib/defaultCategories.js). They are
  -- not seeded here because this function cannot encrypt, and migration 019 drops
  -- categories.name entirely.

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from anon, authenticated, public;

-- --- the independent witness ------------------------------------------------
-- DEFENCE IN DEPTH ONLY. Not the proof, and it must never be treated as one:
-- PostgreSQL's cumulative statistics exclude in-progress transactions and are
-- explicitly allowed to lag, and they do not count TRUNCATE as tuple writes. The
-- barrier above is the proof; this catches the leftovers — most usefully a
-- committed delete-then-insert inside an already-scanned offset window, which by
-- construction leaves both the row count and the gate's digest untouched.
--
-- The gate reads it before and after the scan and fails on any change. It reads,
-- so it never moves the counters itself.
--
-- SECURITY INVOKER (the default) on purpose: pg_stat_all_tables is world-readable
-- and a definer function on the exposed RPC surface is exactly what migration 009
-- had to clean up. Execute is granted to service_role alone.
create or replace function public.encryption_write_counters()
returns table (table_name text, writes bigint)
language sql
stable
set search_path = pg_catalog, public
as $$
  select c.relname::text,
         (coalesce(s.n_tup_ins, 0) + coalesce(s.n_tup_upd, 0) + coalesce(s.n_tup_del, 0))::bigint
  from pg_stat_all_tables s
  join pg_class c on c.oid = s.relid
  where s.schemaname = 'public';
$$;

revoke execute on function public.encryption_write_counters() from anon, authenticated, public;
grant execute on function public.encryption_write_counters() to service_role;

commit;
