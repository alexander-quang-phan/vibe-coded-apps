# Trips, round 2: category budgets inside each city, and trips under Special — plan

> 17 Nov 2026. Builds on Phase 18 trips (live since 17 Nov; spec
> `docs/superpowers/specs/2026-10-13-trips-design.md`). Branch `claude/trips-city-categories`, cut from `main`
> at `e1560fe`. **Draft for Alex: no code until he approves it.**

## What Alex asked for (17 Nov)

"I still don't see the trips feature, and trips are special expenses, and within each trip I want to be able
to set a budget for each city on the trip and category." His answers:
1. City and category budgets: **"Do both and give me the option to toggle the simple version on and off."**
2. Trips and special expenses: **"Show trips under Special"**, meaning keep trips as built, and also show them in
   the Special expenses part of the Dashboard.

## "I don't see it" — what I found

The live site has trips. Its current bundle (`index-DXSwvD4k.js`) contains the Trips link, the Trips page and
Quick Add's trip mode, and there's no service worker caching an old copy. Trips is the 4th item in the top bar
(Dashboard, Transactions, Budgets, **Trips**). On a phone, that bar scrolls sideways. A tab or home-screen app
left open since before 17 Nov runs the old code until it's closed and reopened.

The most likely miss is the one in his message: he expected trips under **Special expenses**, and they aren't
there yet. Change 2 fixes that. Also, in **Simple mode** the trip editor hides category budgets (Simple mode
files everything under "Other"). If he uses Simple mode, he has never seen them. That is question 1 below.

## Change 1 — category budgets inside each city, with a switch

**In the trip editor:** a new switch, **"Budget each city by category"**, off by default (today's behaviour).
I'm deliberately not calling it "simple", because Simple mode already means something else in Trim.
- **Off:** exactly as now: one budget per city, and one per category for the whole trip.
- **On ("both"):** each city also gets its own category lines (Rome: Food £150, Shopping £80). The whole-trip
  category lines and city totals stay.
- Switching it off **hides** the city lines and leaves them out of every figure. They aren't deleted, so
  switching it back on brings them back (question 2).
- No rule makes a city's lines add up to its total, or to the whole-trip lines. A city's lines are just bars.

**On the trip's page:** with the switch on, each city in "By city" opens to show its own category bars ("Food
£62 of £150"), then "Other categories" for that city's spending in categories without a line. The whole-trip
"By category" section is unchanged.

**How spending is counted:** unchanged. An expense's city is still its date's stop, or the city chosen by hand.
A city's category bar counts expenses in that city and that category. Nothing about stars, monthly budgets or
Quick Add changes.

### Data (migration `017c_trip_city_budgets.sql`)

017b is live, so it can't be edited. 017c sorts after it and before 018. It only adds things, and every
statement can run twice.
- `trips.city_category_budgets boolean not null default false`: the switch. Every existing trip is off, so
  nothing on screen changes.
- `trip_category_budgets.stop_id uuid`: NULL means a whole-trip line; set means that city's line.
- A composite foreign key `(stop_id, trip_id)` references `trip_stops (id, trip_id)` `on delete cascade`, with
  a new unique `(id, trip_id)` on `trip_stops` to make that possible. The database itself then refuses a line
  pointing at another trip's stop, and deleting a stop deletes its lines. A NULL `stop_id` is unaffected.
- The unique `(trip_id, category_id)` becomes **two partial unique indexes**: one line per category for the
  whole trip (`where stop_id is null`), and one per category per city (`where stop_id is not null`). These
  work on any PostgreSQL version, unlike `NULLS NOT DISTINCT`.
- **Encryption:** no new encrypted field. `amount_limit` is already registered, and `stop_id` and the switch are
  plaintext ids and flags, like the rest. The unapplied 018/018a/019 need no edit, and the runbook's counts (22
  encrypted columns, 13 barriers) still hold. Checked by the existing encryption scope test and the 001→019
  replay.

### API

- A stop in the save body gains an optional `categoryBudgets: [{ categoryId, amount }]`, nested inside the
  stop, because a new stop has no id yet when the save is sent. The top-level `categoryBudgets` stays the
  whole-trip lines. The trip gains `cityCategoryBudgets: boolean`.
- **Validation:** one line per category within each city (409 otherwise), the same category checks as today
  (yours, for spending), at most 30 lines per city.
- **Saving:** existing stops' lines are diffed by (city, category), the same way whole-trip lines are today.
  A new stop is inserted first, then its lines. A removed stop's lines are deleted explicitly before the stop,
  because the test database has no cascade.
- **A trap fixed in the plan:** today's "remove a whole-trip category line" delete filters on trip and category
  only. Once city lines exist it would delete those too, so it gains `stop_id is null`. Pinned by a test.
- `GET /api/trips` and `GET /api/trips/:id` return each stop's `categoryBudgets`, and with the switch on,
  `summary.byStop[].byCategory` and `.otherCategoriesSpent`.
- devMock mirrors all of it through the shared `lib/trips.js` and `lib/tripRules.js`.

## Change 2 — trips under Special expenses on the Dashboard

The Dashboard's **Special expenses** panel gains a **Trips** list under its groups. It shows each trip that
isn't archived, newest first: name, dates and what's been spent, each linking to the trip. Then
"All trips →". Its collapsed header adds "· 2 trips", so trips show without opening it. The existing line
"£X of this month's special spend is on trips" stays. The panel's headline total stays the groups' lifetime
total, so it doesn't count trip spending twice (question 3).

The panel shows only while Settings → Special expenses is on, which saving a keep-out trip already turns on.

## Steps (one builder; one agent at a time; commit after each green step)

0. **Read-only check of the live database (needs your yes):** no `_enc` column, no barrier, migration `trips`
   applied, `trip_category_budgets` constraint name and row count.
1. **017c + real-PostgreSQL tests:** replay 001→017c, then 017c again. Assert the two uniques, the cross-trip
   refusal, that deleting a stop cascades only its lines, existing rows unchanged, and 001→019 still replays.
2. **Shared rules and figures** (`lib/tripRules.js`, `lib/trips.js`): the nested schema, validation, diff by
   (city, category), and per-city figures. Pure tests.
3. **Route and devMock**, tested at all three encryption phases, with bystander rows (another trip's and
   another user's city lines) so a dropped filter fails a test, then a mutation sweep of the new filters.
4. **Client:** the editor switch and per-city lines, the per-city bars on the trip page, and the Trips list in
   the Special panel.
5. **Click through in the real app** (only login swapped out) at 375, 768 and 1024px. Simple mode as you
   answer.
6. **Docs:** FEATURES, ARCHITECTURE, BUILD_PLAN, SECURITY, handoff.
7. **Independent review**, one agent. It also covers the trips red-team pass that never finished on 3 Nov:
   trips went live without it.
8. **Deploy checklist** (017c → `main` → API → client). Nothing deploys without your go-ahead.

## Out of scope

City or category budgets in a local currency; Quick Add showing a city's category budget; any change to how
spending is counted or starred; the Special panel's headline total.

## Open questions for Alex

1. **Simple mode:** keep category budgets (whole-trip and per-city) hidden there, as today? *Recommend yes:*
   Simple mode files everything under "Other", so they would always read £0. City totals stay visible.
2. **Switching it off:** keep the city lines (hidden), or delete them on save? *Recommend keep*, so toggling
   costs nothing.
3. **The Special panel's total:** leave it as the groups' total, with trips listed under it? *Recommend yes*:
   adding trips would count some spending twice.
4. **The read-only database check** in step 0.
