# Chat Handoff — updated 2026-08-10

## DUAL-AGENT BATON  (both models: update this the MOMENT you finish work)
- Current stage:  no loop active — Phase 11 was ordinary feature work, single-model by design
- Model A is:     not yet set — Alex chooses at the next kickoff
- Up next:        **multi-currency (Phase 12)** — design decided, not yet specced or built
- Last actor did: Phase 11 (running average) built + verified + committed; three of Alex's
                  reported items fixed; a partial validation sweep whose findings are below
- Next must:      write the multi-currency spec, then plan, then build. NOTHING is deployed yet.
- Last verdict:   —
- Handoff log:
  - 2026-07-23 Claude Code: baton added — Trim retrofitted into the dual-agent workflow
  - 2026-08-08 Claude Code: Phase 10 A1–A6 + B1 + B2, built, verified, deployed
  - 2026-08-10 Claude Code: Phase 11 + bug fixes, committed to `main`, **NOT deployed**

## ⚠️ Everything below is on `main` but NOT DEPLOYED
Ten commits, `a2e29db`..`c3afa6f`. Run the `/deploy` skill when Alex is ready. No migration is
needed — nothing this session touched the schema.

## What shipped this session

### Phase 11 — running average of monthly expenses (the feature Alex asked for)
Average monthly spend over the last 3 / 6 / 12 **completed** months, on the Analytics page.
Spec: `docs/superpowers/specs/2026-08-10-running-average-design.md`.
Plan: `docs/superpowers/plans/2026-08-10-running-average.md`.

- `server/lib/runningAverage.js` — the one definition, 12 unit tests. Suite is 64/64.
- `/api/analytics` returns `average` with all three windows precomputed (no refetch on switch).
- `client/src/components/AverageMonthCard.jsx`, mounted at the top of Analytics.
- `QuickAddDialog` gained `initialDate`; the empty-month prompt opens it pre-dated.

Three decisions not to relitigate: completed months only (a part-month biases the mean low);
`trim:avgIncludeSpecial` is deliberately separate from the hero's `trim:heroIncludeSpecial`;
an empty month counts as £0 **but is flagged**, because it may be a month Alex forgot to log.

### Alex's three reported items
1. **Multi-currency** — DESIGN DECIDED, NOT BUILT. See below.
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

## NEXT UP — Phase 12, multi-currency (Alex going to France + Italy)

**Decided (2026-08-10):** convert at entry, store both.

Store the GBP figure in `amount` as today, plus the original amount, its currency, and the rate
used. Every existing total, budget, average and projection keeps summing one GBP number and needs
no change — that is the whole point of the choice, given this codebase has already had two
screens disagree about the same figure once. Display as `−£38.52` with `€45.00` underneath.

Rate source: **Frankfurter (ECB daily rates, free, no API key)**, with a manual-override box for
a bad rate or no connection. Still to decide during design: where rates are cached, what happens
when the fetch fails at entry time, and whether historical rows can be re-rated.

Needs a migration (three columns on `transactions`) — the first this session.

## Validation sweep — READ THIS BEFORE TRUSTING ITS NUMBERS

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
- 10. `projections.js` compares all-category spend against a partial budget — HIGH
- 11. Simple-mode card counts special expenses against the monthly limit while its own pace line
  does not — HIGH
- 12. Weekly budgets measured against a full month of spend — MEDIUM
- 13. Donut percentages divide special-excluded category totals by a special-included total — MEDIUM
- 14. Ask Trim's budget context includes special expenses and ignores budget period — MEDIUM

**10 and 11 are the ones to check first** — both are the "two screens disagree about one figure"
class that `overallBudget.js` was created to end.

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
