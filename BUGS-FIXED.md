# Bugs fixed in Trim

The record of what has already broken here. **Read this before writing or reviewing code in this
project.** Reintroducing a bug listed below is a P0.

After fixing any real bug, append one row: what it was, why it mattered, how it was fixed.

---

## 2026-09-22 — The Analytics incl./excl.-special chip moved only one card

**What it was.** On Analytics, the incl./excl.-special chip lived *inside* `AverageMonthCard` and
was owned by that component's own `useState`. Nothing else on the page could see it, so flipping it
changed the average figure and nothing else: this month, **last month**, the change %, the chart's
expense line, the top-category bars and every row of the monthly history all carried on counting
special one-offs.

**Why it mattered.** Two different measures sat side by side on one screen with nothing saying which
was which — an average that excluded a £240 weekend trip directly above a "last month" that
included it. Alex reported it twice (once around 2026-09-05, again 2026-09-22), which is the real
cost: a number you cannot trust is worse than a number you do not have.

**How it was fixed.** Ownership of the choice moved up to `pages/Analytics.jsx`, the way
`Dashboard.jsx` owns `trim:heroIncludeSpecial` for its hero, and is passed down. `/api/analytics`
now serves *both* bases in one response (`mom.thisMonthSpecial`, `mom.lastMonthSpecial`,
`mom.deltaPctExclSpecial`, `topCategoriesExclSpecial`) so one flip moves the whole page without a
refetch. `topCategoriesExclSpecial` is its **own** top five, because removing special spend can
change *which* five categories are on top — a client-side filter of the incl. list cannot do that.

**The second half of this bug, and the more important half.** The fix above was written on
2026-09-05 and then **left uncommitted in the working tree for 17 days**. The last commit on `main`
was 2026-08-19. Alex kept seeing the bug because the fix never reached `main` and never deployed —
verified by fetching the live bundle from `trim-budget.vercel.app`, which contained the old in-card
chip and none of the new fields. Code that is not committed, merged and deployed has not fixed
anything. See the Definition of Done in CLAUDE.md, step 4.

---

## 2026-09-22 — devMock and the real route rounded the change % differently

**What it was.** `scripts/devMock.js` rounded `mom.deltaPct` to 2 decimal places while
`routes/analytics.js` rounded to 1. The same data showed `+12.57%` under `npm run dev:mock` and
`+12.6%` in production.

**Why it mattered.** Small, but it is the exact class of drift that CLAUDE.md singles out: the mock
is what dev actually exercises, so a mock and a route that disagree let a difference ship unseen.

**How it was fixed.** The mock's `pctChange` helper now uses `.toFixed(1)`, matching the route.

---

## Earlier bugs, recorded from BUILD_PLAN.md / FEATURES.md when this ledger was created (2026-09-22)

These pre-date the ledger and are transcribed from the project docs rather than from a live fix, so
treat the detail as a pointer to the docs rather than a first-hand account.

| Date | Bug | Why it mattered | Fix |
|---|---|---|---|
| Phase 10 A1 | Money fields used `type="number"`. A number input reports `''` for any string that isn't yet a complete number, so a controlled React field ate the decimal point as it was typed and rejected a comma outright. | Decimals were **impossible on a phone in a comma-decimal locale** — which is Alex's (`pl-PL`). | All seven money fields go through `components/ui/money-input.jsx`: `type="text"` + `inputMode="decimal"` with a sanitiser that normalises `,` → `.`. |
| Phase 10 A5 | "Your total budget" was computed independently in `projections.js`, `affordability.js` and `budgets.js`. | Two of them disagreed on the same Dashboard screen. | One definition in `server/lib/overallBudget.js`; all three read from it. |
| — | `AuthProvider`'s `supabase.auth.getSession()` had no `.catch()`. | A rejected call — offline, or Supabase unreachable — left `isLoading` true forever: a spinner with no error and no way forward. | Catch and treat as "no session", which sends the user to the login screen. |
| 2026-08-08 → reported later | A server route and its `devMock.js` mirror disagreed (special groups). | The feature worked locally and failed in production; it survived undetected until Alex hit it. | Mirror **every** route change into `scripts/devMock.js` in the same session — now a rule in CLAUDE.md. |

---

## The recurring shapes

Three failure modes have now produced more than one bug each. Check for them by name:

1. **One number, two definitions.** The same quantity computed in two places drifts. Give it one
   home (`overallBudget.js`, `runningAverage.js`, `special.js`, the server-side `deltaPct`).
2. **Route and mock disagree.** `devMock.js` is what dev exercises. A route change that does not
   land in the mock ships a difference nobody sees.
3. **Done but not shipped.** "Built", "tests pass" and "the build is clean" are not "Alex can use
   it". Nothing counts until it is committed, on `main`, and deployed.
