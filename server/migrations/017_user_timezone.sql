-- Trim — Phase 14: store the user's timezone.
--
-- Every period boundary on the server was computed from the SERVER's UTC clock:
-- three separate copies of monthBounds() plus a dozen ad-hoc getUTCMonth()
-- calls. For anyone not on UTC that answers the wrong question. A user in Paris
-- logging at 00:30 on the 1st is in a new month while the server is still in the
-- old one, so their fresh transaction dropped out of "this month" until 02:00
-- local — about an hour a day in London BST, two in CEST. Alex hit this
-- travelling.
--
-- One nullable column. NULL means "not reported yet", and every consumer falls
-- back to UTC (DEFAULT_TIMEZONE in server/lib/month.js), which is exactly the
-- behaviour every existing row has today — so this migration changes nothing
-- until a client reports a zone, and there is no backfill.
--
-- Paste into the Supabase SQL editor and run once. Additive only.

alter table public.user_stats
  add column if not exists timezone text;

-- An IANA zone name, loosely shaped: "Area/Location", optionally with a second
-- slash (America/Argentina/Salta), or the bare "UTC". Deliberately a shape
-- check, not an allow-list — the tz database gains entries and a row that
-- cannot be written is worse than one holding a zone we then fail open on.
-- server/lib/month.js falls back to UTC for anything Intl cannot resolve.
alter table public.user_stats
  drop constraint if exists user_stats_timezone_shape;
alter table public.user_stats
  add constraint user_stats_timezone_shape check (
    timezone is null
    or timezone = 'UTC'
    or timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'
  );

-- No new RLS policy: this is a column on user_stats, already covered by its
-- existing per-user policies. No index — it is only ever read alongside the row.
