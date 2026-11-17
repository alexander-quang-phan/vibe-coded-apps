# Phase 18 (trips): deploy checklist

**Nothing here has been done yet.** Trips is built on the branch `claude/confident-northcutt-6cd9f9`. It is not on `main`, it is not deployed, and migration 017b is not on the live database.

**Why the order matters.** The new API reads `trip_id` on every transaction. If it deploys before the migration, every transaction read and create fails. So: database first, then API, then client. The old API and old client both ignore the new columns, so step 2 is safe to do first and to leave in place.

Claude can run all of this if you say so, as it did for Phase 17. Each live-database step needs your yes in chat.

## 1. Check the live database (read-only)

```sql
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name like '%\_enc') as enc_columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('reject_writes_during_cutover', 'encryption_write_counters')) as barrier_functions,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name in ('trips', 'trip_stops', 'trip_category_budgets')) as trip_tables,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'recurrences' and column_name = 'auto_log') as has_017a;
```

**Expect:** `enc_columns = 0`, `barrier_functions = 0`, `trip_tables = 0`, `has_017a = 1`.

**If `enc_columns` is not 0, or `barrier_functions` is not 0, stop.** Encryption has started, so the in-place edits to 018 and 018a won't be applied, and the trip columns need new migration files. Last checked 3 Nov 2026: all as expected.

## 2. Apply migration 017b

Apply `server/migrations/017b_trips.sql` with Supabase's `apply_migration`, named `trips`, so it shows in the migration list like the others. It only adds things, and it is safe to run twice.

Then check it took:

```sql
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name in ('trips', 'trip_stops', 'trip_category_budgets')) as tables_3,
  (select count(*) from pg_constraint
    where conname in ('transactions_trip_xor_group', 'transactions_trip_expense_only')) as checks_2,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions' and column_name in ('trip_id', 'trip_stop_id')) as columns_2,
  (select count(*) from pg_class
    where relname in ('trips', 'trip_stops', 'trip_category_budgets') and relrowsecurity) as rls_on_3,
  (select count(*) from public.transactions where trip_id is not null) as tagged_rows_0;
```

**Expect:** 3, 2, 2, 3, 0.

## 3. Merge to `main`

Use the `/deploy` skill. Merge the branch, then re-run both checks on the merged code:

```bash
cd server && npm test
```

```bash
cd client && npm run build
```

**Expect:** all tests pass with none skipped, and the build passes. Check `vercel env ls production` on `trim-api`: `ENCRYPTION_PHASE` and `DATA_ENCRYPTION_KEY` should still be absent.

## 4. Deploy `trim-api`

**Expect:** `/api/health` answers 200, and `/api/trips` answers 401 without a login (not 404, which would mean the old API is still running).

## 5. Deploy the client

**Expect:** the live bundle at trim-budget.vercel.app contains `Planning a getaway`, and the login page loads with no console errors.

The client goes last because an old API has no `/api/trips`. The new client copes (Quick Add says "Couldn't check your trips" and logs normally), but the Trips tab would show an error.

## 6. Your check, logged in (about 5 minutes)

Claude can't sign in, so this is the one part that has only ever run against the mock.

1. **Trips → New trip.** Dates around today, a budget, one stop in another currency. Save. It should say Special expenses is on now, if it was off.
2. **Quick Add from the Dashboard.** You should see "✈️ Name · City" at the top, and the stop's currency selected. Log something with the normal taps. The toast should read "Logged to Name ✈️".
3. **Budgets.** That expense should not have moved your monthly figures, and a line should say the spending is tracked on its trip.
4. **The trip's page.** Check the figures add up. Tap the expense, fix the note and save. Its star shouldn't change.
5. **"Not trip spending".** Log another, tap that button on the toast. It should leave the trip and count in your monthly budget.
6. **Delete your test trip**, choosing "Count them in my monthly budget again".

Report anything odd. A screenshot is ideal.

## Rolling back

- **The API or client misbehaves:** in Vercel, promote the previous `trim-api` and `trim-budget` deployments. **Leave 017b in place.** The old API ignores the new columns.
- **017b itself** (only while no trip data exists):

```sql
alter table public.transactions
  drop constraint if exists transactions_trip_xor_group,
  drop constraint if exists transactions_trip_expense_only,
  drop column if exists trip_id,
  drop column if exists trip_stop_id;
drop table if exists public.trip_category_budgets, public.trip_stops, public.trips;
```

## Afterwards

The encryption rollout (`docs/PHASE-9.5-PART-A-RUNBOOK.md`) already expects trips: 22 encrypted columns and 13 barriers. Its Step 2 checks that 017a and 017b went first.
