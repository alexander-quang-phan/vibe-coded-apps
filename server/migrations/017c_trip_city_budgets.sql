-- 017c — trips, round 2: category budgets inside each city, behind a per-trip switch.
--
-- Plan: docs/superpowers/plans/2026-11-17-trips-city-categories.md
--
-- WHY THE NAME. 017b is live and can't be edited; 019 must sort last
-- (test/encryptionScope.test.js). 017c sorts after 017b and before 018. Checked against
-- the live database on 2026-11-17: through 017b applied, no `_enc` column, no trip rows.
--
-- APPLY THIS BEFORE DEPLOYING THE API THAT SELECTS `stop_id` and `city_category_budgets`.
--
-- Additive only, and every statement is idempotent, so running it twice is safe. No new
-- encrypted field: `amount_limit` is already registered, and these are a flag and an id.

-- The switch. Off for every existing trip, so nothing on screen changes. Switching it off
-- later hides a trip's city lines; it never deletes them.
alter table public.trips
  add column if not exists city_category_budgets boolean not null default false;

-- What lets the foreign key below say "a stop OF THIS TRIP". `id` is already unique, so
-- this can never fail on existing rows.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'trip_stops_id_trip_unique') then
    alter table public.trip_stops add constraint trip_stops_id_trip_unique unique (id, trip_id);
  end if;
end $$;

-- NULL is a line for the whole trip; set, it's that city's line. The composite key makes the
-- database refuse a line pointing at another trip's stop (the service role bypasses RLS, and
-- the test harness enforces nothing), and deleting a stop takes its lines with it. MATCH
-- SIMPLE: a NULL stop_id is never checked, so whole-trip lines are unaffected.
alter table public.trip_category_budgets
  add column if not exists stop_id uuid;
alter table public.trip_category_budgets drop constraint if exists trip_category_budgets_stop_fk;
alter table public.trip_category_budgets
  add constraint trip_category_budgets_stop_fk
  foreign key (stop_id, trip_id) references public.trip_stops (id, trip_id) on delete cascade;

-- One line per category for the whole trip, and one per category in each city. Two partial
-- indexes rather than NULLS NOT DISTINCT, so this replays on any PostgreSQL version.
alter table public.trip_category_budgets drop constraint if exists trip_category_budgets_unique;
create unique index if not exists trip_category_budgets_trip_line
  on public.trip_category_budgets (trip_id, category_id) where stop_id is null;
create unique index if not exists trip_category_budgets_city_line
  on public.trip_category_budgets (trip_id, stop_id, category_id) where stop_id is not null;
