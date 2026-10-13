-- 017a — Phase 17: subscriptions Alex marks himself, tracked but never auto-logged.
--
-- Spec: docs/superpowers/specs/2026-10-13-subscription-marking-design.md
--
-- WHY THE NAME. `019_encryption_drop_plaintext.sql` must sort LAST of all
-- (test/encryptionScope.test.js), so this cannot be 020. `017a` sorts after
-- 017_user_timezone and before 018. Verified against the live database on
-- 2026-10-13: 014-017 applied, 012/018/018a/019 NOT applied. Nothing here depends
-- on those, and they do not depend on this, so applying 017a now and the
-- encryption migrations later is valid, and so is a from-scratch replay.
--
-- APPLY THIS BEFORE DEPLOYING THE API THAT SELECTS `auto_log`, or the
-- Subscriptions page 500s.
--
-- Every statement is idempotent, so running it twice is safe.

-- auto_log: true  = "Repeat this" — the nightly job inserts each charge. Every
--                   EXISTING row gets true, so their behaviour does not change.
--           false = tracked only — Alex logs the charges himself. The nightly job
--                   must never fire these (it filters auto_log = true twice).
alter table public.recurrences
  add column if not exists auto_log boolean not null default true;

-- A tracked row has no "next run": its next expected date is derived from the
-- charges attached to it, at read time. A NULL next_run_at can never satisfy the
-- job's `next_run_at <= …` filter, which makes it a second, independent guard.
alter table public.recurrences alter column next_run_at drop not null;
alter table public.recurrences drop constraint if exists recurrences_next_run_required;
alter table public.recurrences
  add constraint recurrences_next_run_required check (not auto_log or next_run_at is not null);

-- Yearly subscriptions. `annual` (not `yearly`) because detected rows and the
-- merchant-key regex already use it; the UI says "Yearly".
alter table public.recurrences drop constraint if exists recurrences_interval_check;
alter table public.recurrences
  add constraint recurrences_interval_check check (interval in ('monthly', 'weekly', 'annual'));
