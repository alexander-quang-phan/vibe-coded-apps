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
-- DATABASE enforces. While the barrier is engaged, every insert, update and
-- delete on the app's tables is rejected by a trigger. The gate refuses to run
-- unless it is engaged, and refuses to pass if it was engaged later than the scan
-- began or was released while the scan was running.
--
-- HOW TO USE IT (this is step 7 of the rollout in SECURITY.md)
-- ----------------------------------------------------------------------------
--   1. Disable the 03:00 recurrences cron in vercel.json / the Vercel dashboard.
--   2. ENGAGE:
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
create or replace function public.reject_writes_during_cutover()
returns trigger
language plpgsql
as $$
begin
  if (select engaged from public.encryption_cutover where id = true) then
    raise exception
      using errcode = '25006', -- read_only_sql_transaction
            message = 'Trim is in the Phase 9.5 encryption cutover window; writes are blocked',
            hint = 'Release it with: update public.encryption_cutover set engaged = false, engaged_at = null;';
  end if;
  return null; -- ignored for statement-level triggers
end;
$$;

-- Every table that holds an encrypted column, i.e. every table migration 019
-- touches. Kept in step with lib/encryptedFields.js by
-- test/encryptionScope.test.js, which fails the build if a registered table has
-- no barrier here.
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
      'create trigger %I before insert or update or delete on public.%I '
      || 'for each statement execute function public.reject_writes_during_cutover()',
      t || '_encryption_cutover_guard', t);
  end loop;
end $$;

-- --- the independent witness ------------------------------------------------
-- Defence in depth, and the thing that makes Codex's probe fail deterministically
-- rather than merely improbably. pg_stat counts every tuple inserted, updated or
-- deleted since the last stats reset, so ANY write to a guarded table moves this
-- number — including the delete-then-insert inside an already-scanned offset
-- window, which by construction left both the row count and the digest untouched.
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
