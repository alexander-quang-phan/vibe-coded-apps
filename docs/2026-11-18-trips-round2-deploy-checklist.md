# Trips round 2: deploy checklist

**Nothing here has been done yet.** The changes are on the branch `claude/trips-city-categories`: category
budgets inside each city, and the reworked Special expenses panel. They aren't on `main` or deployed, and
migration 017c isn't on the live database.

**The order matters for the same reason as last time.** The new API reads `stop_id` and
`city_category_budgets`, so the database goes first, then the API, then the client. The live API and client
ignore the new columns, so step 2 is safe to do first and to leave in place.

Claude can run all of this if you say so. Each live-database step needs your yes in chat.

## 1. Check the live database (read-only)

```sql
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name like '%\_enc') as enc_columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('reject_writes_during_cutover', 'encryption_write_counters')) as barrier_functions,
  (select count(*) from pg_constraint where conname = 'trip_category_budgets_unique') as old_unique,
  (select count(*) from public.trip_category_budgets) as budget_lines;
```

**Expect:** `enc_columns = 0`, `barrier_functions = 0`, `old_unique = 1`. `budget_lines` was 0 on 17 Nov; any
number is fine, because 017c leaves existing lines as whole-trip lines.

**If `enc_columns` or `barrier_functions` is not 0, stop:** encryption has started, which changes the plan.

## 2. Apply migration 017c

Apply `server/migrations/017c_trip_city_budgets.sql` with Supabase's `apply_migration`, named
`trip_city_budgets`. It only adds things, and it is safe to run twice.

Then check it took:

```sql
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'trips' and column_name = 'city_category_budgets') as switch_1,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'trip_category_budgets' and column_name = 'stop_id') as stop_id_1,
  (select count(*) from pg_constraint
    where conname in ('trip_stops_id_trip_unique', 'trip_category_budgets_stop_fk')) as keys_2,
  (select count(*) from pg_indexes
    where indexname in ('trip_category_budgets_trip_line', 'trip_category_budgets_city_line')) as uniques_2,
  (select count(*) from pg_constraint where conname = 'trip_category_budgets_unique') as old_unique_0,
  (select count(*) from public.trip_category_budgets where stop_id is not null) as city_lines_0;
```

**Expect:** 1, 1, 2, 2, 0, 0.

## 3. Merge to `main`

Use the `/deploy` skill. Merge the branch, then re-run both checks on the merged code:

```bash
cd server && npm test
```

```bash
cd client && npm run build
```

**Expect:** all tests pass with none skipped, and the build passes. On `trim-api`, `ENCRYPTION_PHASE` and
`DATA_ENCRYPTION_KEY` should still be absent.

## 4. Deploy `trim-api`

**Expect:** `/api/health` answers 200, and `/api/trips` answers 401 without a login.

## 5. Deploy the client

**Expect:** the live bundle at trim-budget.vercel.app contains `Budget each city by category` and
`All-time totals`, and the login page loads with no console errors.

## 6. Your check, logged in (about 5 minutes)

1. **Close and reopen Trim.** On a phone home-screen app, close it fully first, because an app left open keeps
   running the old version. Then go to **Trips**, the 4th item in the top bar (it scrolls sideways on a phone).
2. **New trip** with two cities. Under the cities, tick **Budget each city by category**, and give one city
   a Food line. Save.
3. **Log an expense** in that city with Quick Add (Food). On the trip's page, the city's Food bar should move.
4. **Edit the trip, untick the switch, save.** The city's bars disappear. Tick it again: they're back.
5. **Dashboard → Special expenses.** The header says this month's special spend. Opened, it lists your trip
   with ✈️ and your groups, each at its all-time total.
6. Delete the test trip, choosing "Count them in my monthly budget again".

## Rolling back

- **The API or client misbehaves:** in Vercel, promote the previous `trim-api` and `trim-budget` deployments
  (the 17 Nov ones). **Leave 017c in place.** The old API ignores the new columns.
- **017c itself**, only while no city lines exist:

```sql
drop index if exists public.trip_category_budgets_trip_line, public.trip_category_budgets_city_line;
alter table public.trip_category_budgets drop constraint if exists trip_category_budgets_stop_fk;
alter table public.trip_category_budgets drop column if exists stop_id;
alter table public.trip_category_budgets
  add constraint trip_category_budgets_unique unique (trip_id, category_id);
alter table public.trip_stops drop constraint if exists trip_stops_id_trip_unique;
alter table public.trips drop column if exists city_category_budgets;
```
