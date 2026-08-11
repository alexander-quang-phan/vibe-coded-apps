# Chat Handoff — updated 2026-08-11

## DUAL-AGENT BATON  (both models: update this the MOMENT you finish work)
- Current stage:  no loop active — Phase 11 was ordinary feature work, single-model by design
- Model A is:     not yet set — Alex chooses at the next kickoff
- Up next:        Alex's live click-through. **No known open bugs.**
- Last actor did: Phase 11 (running average) built + verified + committed; three of Alex's
                  reported items fixed; a partial validation sweep whose findings are below
- Next must:      nothing blocking. Phases 11, 12, 12b, 13 and 14 are live.
- Last verdict:   —
- Handoff log:
  - 2026-07-23 Claude Code: baton added — Trim retrofitted into the dual-agent workflow
  - 2026-08-08 Claude Code: Phase 10 A1–A6 + B1 + B2, built, verified, deployed
  - 2026-08-10 Claude Code: Phase 11 + Phase 12 + 6 bug fixes, migration 016 applied, DEPLOYED
  - 2026-08-11 Claude Code: Phase 12b + 13 + 14 — every sweep finding closed, timezone fix
    landed, migration 017 applied; DEPLOYED. No known open bugs.

## ✅ DEPLOYED 2026-08-11 — Phase 13 finish pass

Both projects redeployed. **No migration** — Phase 13 touched no schema. Production verified:
`/api/health` 200, everything else 401 without a token, and the live bundle carries the new
strings with no `toISOString().slice(0,10)` day-stamping left anywhere.

### Everything the two sweeps found is now closed or consciously deferred

Fixed on 2026-08-11 (`85d7e76`, `c0322fa`, `7f625ac`, `3495075`):
- **Local calendar day end-to-end.** One `todayISO()` in `client/src/lib/format.js`; a create sends
  `clientToday` so the streak follows the user's day, separate from `date` so backdating cannot
  count as logging today.
- **Phase 12b** — a transaction's currency can be changed after creation, with the same
  server-derived amount and rate gate. `foreign: null` restores a plain row.
- **`invalidateMoney()`** — ten drifted hand-lists became one definition. This is the third time
  this class of bug has appeared; do not hand-list keys in a mutation again.
- **One `ZERO_DECIMAL`** (money-input had only VND while fx.js had six, so Quick Add accepted
  "100.50" in JPY); `/api/dashboard` now returns the Phase 12 columns.
- **Failure states** — `getSession()` catch, paused-query guards on Dashboard/Analytics/Settings.
  The Settings one mattered most: offline it showed factory defaults and saving would have written
  them over the real settings.
- **Dead ends** — budget link, `aria-pressed` chips, month dropdown no longer collapsing.

### Three of those four closed 2026-08-11 (`65d2728`, deployed)

- Ask Trim rendered the history-failure banner INSTEAD of the message list, and `isError` stays
  true for the session — so its copy invited you to send something you would then never see. Now a
  notice above the conversation.
- 27 bare `text-amber-400` became `text-amber-600 dark:text-amber-400`. There is a real light theme
  (`App.jsx` toggles it) where amber-400 on white was ~1.7:1.
- The budget dialog now names the category being edited.

### Phase 14 — the last open item, now closed (migration 017 applied, deployed)

Server-side month bucketing no longer runs on the server's clock. `user_stats.timezone` holds the
user's IANA zone, reported automatically by the client only when it differs from what is stored.
Every boundary comes from `server/lib/month.js` — one pure tz-aware definition that replaced three
copies of `monthBounds` and a dozen `getUTCMonth()` calls across dashboard, budgets, affordability,
projections, analytics, wins and ask. 10 unit tests; suite is 82.

Migration 017 verified: 7 user rows and 139 transactions **unchanged**, `user_stats` 14 → 15
columns, **0 rows touched**, constraint in, RLS on. A NULL zone behaves exactly as before (UTC), and
an unresolvable zone fails open to UTC rather than erroring.

**Do not reintroduce a UTC clock read for a period boundary.** `transactions.date` is a calendar day
in the USER's zone; anything compared against it must come from `lib/month.js`.

Known non-issues, checked and deliberately left as UTC: the `/api/fx` daily rate cache, the nightly
recurrence runner's own "today", and `nextMonthFirstISO()` in transactions.js (pure string
arithmetic on a supplied `ym`, no clock).

## Previously deployed 2026-08-10 — migration 016 applied
18 commits, `a2e29db`..`fb8ad17`, pushed to `main` and deployed.

**Migration 016 was applied to the live DB** via the Supabase connector (project
`fqfzjcpypxvikdgmegzq`), with Alex's explicit go-ahead. Verified before/after: 137 transactions and
85 categories **unchanged**, `transactions` went 13 → 16 columns, **0 existing rows touched**, both
check constraints present, RLS still on.

Production verified after deploy: `/api/health` 200; `/api/fx`, `/api/analytics`,
`/api/transactions`, `/api/special-groups`, `/api/affordability`, `/api/dashboard` and `/api/me` all
401 without a token (`/api/fx` returning 401 rather than 404 is the proof the new route shipped);
client 200 with every Phase 11 and Phase 12 marker string in the live bundle.

**Phase 12 could not be deployed before the migration** — the insert writes three new columns, so
API-first would have 500'd every transaction create, and client-first would have been worse: the old
server strips unknown fields, silently logging a €45 tour as £45. Order was migration → API → client.
Remember this for the next schema change.

## What shipped this session

### Phase 11 — running average of monthly expenses (the feature Alex asked for)
Average monthly spend over the last 3 / 6 / 12 **completed** months, on the Analytics page.
Spec: `docs/superpowers/specs/2026-08-10-running-average-design.md`.
Plan: `docs/superpowers/plans/2026-08-10-running-average.md`.

- `server/lib/runningAverage.js` — the one definition, 12 unit tests. Suite is 72/72
  (Phase 12 added 8 more in `server/test/fx.test.js`).
- `/api/analytics` returns `average` with all three windows precomputed (no refetch on switch).
- `client/src/components/AverageMonthCard.jsx`, mounted at the top of Analytics.
- `QuickAddDialog` gained `initialDate`; the empty-month prompt opens it pre-dated.

Three decisions not to relitigate: completed months only (a part-month biases the mean low);
`trim:avgIncludeSpecial` is deliberately separate from the hero's `trim:heroIncludeSpecial`;
an empty month counts as £0 **but is flagged**, because it may be a month Alex forgot to log.

### Alex's three reported items
1. **Multi-currency** — BUILT AND LIVE. See the Phase 12 section below.
2. **Special-expense group not saving** — FIXED. Two independent bugs with one symptom:
   - `POST /api/transactions` validated `specialGroupId`, guarded it, then **omitted
     `special_group_id` from the insert**. `PATCH` did write it, which is exactly why redoing
     it appeared to work. Hidden because `scripts/devMock.js` persists it correctly — it worked
     against the mock and failed only against the real API.
   - No transaction mutation invalidated `['special-groups']`, so the Dashboard's by-group panel
     stayed stale even once the write was fixed.
3. **"Can I afford this?" ignoring the special toggle** — FIXED. It was hard-wired to the
   excl.-special basis. The toggle now lives on `Dashboard` and drives both cards; the API takes
   an optional `includeSpecial`.

### Also fixed (found while working, not asked for)
- **The floating add button would have been stranded ~7000px down the Transactions page.**
  `position: fixed` resolves against the nearest ancestor with a transform, and the
  `animate-fade-up` utility has fill-mode `both` — so it leaves a **permanent identity
  transform** on any page root that uses it. Dashboard's root happens not to animate, which is
  why this never surfaced. `QuickAddButton` now portals to `<body>`. **Read this before adding
  any other fixed-position element to a page whose root has `animate-fade-up`.**
- Transactions page can now add transactions at all (it was edit/delete only), seeded to the
  filtered month when that month is in the past.
- Stale-cache family: Quick Add, Dashboard delete and Transactions edit/delete each invalidated
  a different subset of keys. All three now invalidate the same set, including `['analytics']`,
  `['special-groups']` and `['budgets']`.

## Phase 12 — multi-currency (BUILT AND LIVE)

**Built 2026-08-10.** Convert at entry, store both. Spec:
`docs/superpowers/specs/2026-08-10-multi-currency-design.md`.

Store the GBP figure in `amount` as today, plus the original amount, its currency, and the rate
used. Every existing total, budget, average and projection keeps summing one GBP number and needs
no change — that is the whole point of the choice, given this codebase has already had two
screens disagree about the same figure once. Display as `−£38.52` with `€45.00` underneath.

Rate source: **Frankfurter (ECB daily), free, no API key**, cached in-process per day, 4s abort.
It publishes 30 currencies and **does NOT cover VND**, one of Trim's five base currencies — so
typing the rate by hand is a first-class path, and the rate stays editable regardless (ECB's
reference rate is not what a card charges).

**The server derives the stored amount** from original × rate and IGNORES the client's `amount`.
Verified by posting a deliberately wrong 999 and getting 38.50 stored.

Not done: editing a transaction's currency after creation (PATCH does not accept `foreign`);
re-rating historical rows; currencies on income, budgets or goals.

## Second sweep (dates / edges / ux) — COMPLETED CLEANLY 2026-08-10

11/11 agents, 3/3 lenses, 0 failures. 19 raw findings, 8 verified, 7 confirmed, 1 refuted,
11 below the verify cap and still unchecked.
Journal: `~/.claude/projects/.../subagents/workflows/wf_2904c886-297/journal.jsonl`.

**Fixed and deployed (`c500bc4`):**
- **HIGH, and self-inflicted:** a foreign expense with no rate was logged as base currency.
  `foreignPayload()` returned `{}` for an empty/zero/half-typed rate while `amount` still held the
  FOREIGN number, and the server cannot infer the entry currency without the `foreign` block —
  so EUR 45 stored as GBP 45. Submission is now gated on a valid rate, and `foreignPayload()`
  throws rather than degrading silently. **Confirmed independently by two lenses.**
- **MEDIUM:** Dashboard and Analytics white-screened the app when offline — no `!data` guard, and
  a paused TanStack query leaves `isLoading` and `isError` both false.
- **LOW:** Settings claimed "Trim doesn't convert between currencies", false since Phase 12.

**Confirmed but NOT fixed — deliberate, judged not worth the change today:**
- **MEDIUM, dates:** transactions are stamped in UTC (`toISOString().slice(0,10)`) but labelled in
  local time (`new Date(iso + 'T00:00:00')`). Logging between local and UTC midnight files a row
  under the previous day: renders as "Yesterday", and on the 1st of a month lands in the previous
  month for the dashboard, budgets and the running average. ~1h/day in London BST, 2h in CEST.
  **This will affect Alex in France and Italy.** The real fix is picking one clock end-to-end,
  which touches every date path in the app — a focused job, not a patch.
- **MEDIUM, dates:** the streak can break for the same reason (`transactions.js` day comparison).
- **LOW:** the Dashboard's recent-activity rows never show the foreign-currency line, because
  `routes/dashboard.js:43` does not select the new columns. Transactions page does show it.

**Refuted on verification:** "editing a foreign transaction leaves its original amount and rate
stale" — PATCH deliberately does not accept `foreign`, which is documented.

**11 findings below the verify cap, unchecked** (medium/low): month dropdown collapsing to one
option; Ask Trim hiding the conversation when history fails; amber-400 contrast ~1.7:1 in light
mode; Transactions empty state pointing at the wrong add button; "set one" budget dead end;
affordability chips carrying state in colour only; Settings showing factory defaults when
`/api/me` fails; a permanent spinner on `getSession()` rejection; ZERO_DECIMAL drifted into two
definitions; budget edit dialog not naming the budget.

## First sweep — READ THIS BEFORE TRUSTING ITS NUMBERS

A 14-agent sweep was run. **11 of 14 agents died on an account session limit.** Only 3 of 6
finders finished (money, security, cache — `dates`, `edges` and `ux` never ran), and **zero
verifiers ran**. Its `confirmed: 0` therefore means "nothing was verified", NOT "nothing is
wrong". Raw findings recovered from
`~/.claude/projects/.../subagents/workflows/wf_6d5d5542-d9b/journal.jsonl`.

Fixed and personally verified (not by an agent):
1. `POST /api/transactions` dropped `special_group_id` — HIGH
2. `specialGroupId` written with no ownership check — LOW (also fixed)
3. No mutation invalidated `['special-groups']` — HIGH
5. Dashboard delete omitted `['analytics']` — MEDIUM
7. `['budgets']` never invalidated by a transaction change — MEDIUM

**Still open and still UNVERIFIED — treat each as a lead, not a fact:**
- 4. `['affordability']` is never invalidated by any mutation — MEDIUM
- 6. `CategoryManager` invalidates a dead key `['analytics', 6]`; the real key is
  `['analytics', 24]`, and prefix matching means `6` matches nothing — MEDIUM
- 8. Settings' special-expenses toggle refreshes only `me` + `dashboard`, leaving budgets,
  projections, analytics, affordability and wins on the old basis — MEDIUM
- 9. `SimpleMonthCard`'s limit save skips `['projections']`, which the same card renders — LOW
- 12. Weekly budgets measured against a full month of spend — MEDIUM
- 13. Donut percentages divide special-excluded category totals by a special-included total — MEDIUM
- 14. Ask Trim's budget context includes special expenses and ignores budget period — MEDIUM

Both HIGH leads were checked by hand after the sweep:
- **#10 `projections.js` — REFUTED.** It already uses the shared `resolveTotalBudget`/`buildPace`
  and applies `excludeSpecial` first. The agent was describing the pre-Phase-10 bug.
- **#11 simple-mode card — CONFIRMED AND FIXED** (`fb8ad17`). The "X of Y spent" bar used
  `month.expenses`, which includes special spend, while the PaceLine on the same card came from
  `/api/projections/month`, which excludes it. The bar now excludes it too.

The 8 above remain unchecked. None is HIGH.

The three lenses that never ran — dates/timezones, empty-and-error states, UX seamlessness —
are still unexplored. Worth re-running the sweep when the account limit resets.

## Verification notes for whoever picks this up
There is no Supabase login available to an agent, so UI verification was done by writing a
throwaway Vite entry (`client/preview.html` + `src/preview.jsx`) that renders a real page with
the TanStack Query cache pre-seeded from the mock API's actual payload, driving it in a browser,
then deleting the harness. This works well — reuse it. `staleTime: Infinity` + `retry: false`
stops it ever making an authenticated call.

**Not verified:** actually saving a backdated expense and watching the average update live. Needs
Alex's login. The invalidation is in place but untested end to end.

## Older context (still true)
- `server/lib/overallBudget.js` — the ONE definition of "your total budget". Read before touching
  pace, affordability or budgets.
- `client/src/components/ui/money-input.jsx` — every money field. Never reintroduce
  `type="number"` for money.
- `server/lib/special.js` — special expenses are excluded from budget maths ONLY while the
  preference is on. Off = flags dormant, everything counts.
- Alex's old "All Expenses" category cleanup may still be outstanding — check Budgets/Settings.
- Open: 9.5 encryption at rest (half-built and INERT, migration 012 not applied); Phase 8 bank
  sync (blocked on Enable Banking); custom domain; Supabase leaked-password toggle.

## How to resume
Start a session in this folder and say: "Read @CHAT_HANDOFF.md and write the Phase 12
multi-currency spec."
