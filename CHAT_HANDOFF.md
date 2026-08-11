# Chat Handoff — updated 2026-08-11

## DUAL-AGENT BATON  (both models: update this the MOMENT you finish work)
- Current stage:  no loop active — Phases 11–14 were ordinary feature work, single-model by design
- Model A is:     not yet set — Alex chooses at the next kickoff
- Up next:        Alex's live click-through; then the 4 unverified leads under "Next steps"
- Last actor did: Phases 11, 12, 12b, 13, 14 built + verified + deployed; migrations 016 and 017
                  applied; 21 bugs fixed across two validation sweeps
- Next must:      nothing blocking — everything is live and working as far as it can be checked
                  without Alex's login
- Last verdict:   —
- Handoff log:
  - 2026-07-23 Claude Code: baton added — Trim retrofitted into the dual-agent workflow
  - 2026-08-08 Claude Code: Phase 10 A1–A6 + B1 + B2, built, verified, deployed
  - 2026-08-10 Claude Code: Phase 11 + 12, migration 016, DEPLOYED
  - 2026-08-11 Claude Code: Phase 12b + 13 + 14, migration 017, DEPLOYED

## Goal
Alex uses Trim daily and wanted to know what he's been spending in an average month, plus to log
expenses in euros for a trip to France and Italy. That expanded into fixing everything two
validation sweeps turned up, so the app is trustworthy while he's away.

## Current state

**Everything below is on `main` and DEPLOYED.** `a2e29db`..`eba6633`. Server suite 82/82, client
builds clean, working tree clean. Migrations 016 and 017 both applied to the live DB.

**Live and working:**

| Feature | Where |
|---|---|
| Running average, 3/6/12 completed months | Analytics, top card |
| Foreign-currency expenses | Quick Add — currency chip beside Amount |
| Change a transaction's currency | Transactions → edit |
| "Can I afford this?" follows the special toggle | Dashboard |
| Special-expense groups actually save | Quick Add |
| Add transactions from the Transactions page | floating + button |

**21 bugs fixed.** The ones worth remembering are under "Key decisions" and "Traps".

**NOT verified:** nothing has been exercised against Alex's real account — an agent has no Supabase
login. Everything was proven by unit tests, mock-API round trips, and real components driven in a
browser. See "Traps" for the harness technique.

## Key decisions (and why)

- **Running average covers COMPLETED months only.** A part-month biases the mean low and makes the
  figure creep upward all month. The current month is shown beside it, never inside it.
- **`trim:avgIncludeSpecial` is deliberately SEPARATE from `trim:heroIncludeSpecial`.** The hero
  toggles this month's net; the card toggles an N-month average. Flipping one must not change a page
  the user isn't looking at.
- **An empty month counts as £0 but is FLAGGED.** It might be a genuinely cheap month, or one Alex
  forgot to log — averaging it silently would flatter him.
- **Foreign currency converts AT ENTRY; `transactions.amount` stays single-currency.** This is why
  no total, budget, average, projection or affordability check needed changing. Converting on read
  would have put a conversion step inside all of them.
- **The SERVER derives the converted amount and ignores the client's `amount`.** Proven by posting a
  deliberately wrong 999 and getting 38.50 stored.
- **Manual FX rate entry is a first-class path, not a fallback.** Frankfurter (ECB) publishes 30
  currencies and does NOT cover VND, one of Trim's five base currencies. The rate is always editable
  regardless — ECB's reference rate is not what a card charges.
- **A calendar day belongs to the user, not the server** (Phase 14). `user_stats.timezone` holds
  their IANA zone, reported automatically by the client only when it changes.

## Traps — read before touching these areas

1. **Never hand-list cache keys in a mutation.** Use `invalidateMoney()` from
   `client/src/lib/invalidate.js`. Ten call sites had each drifted to a different subset; this class
   of bug appeared three times.
2. **Never reintroduce a UTC clock read for a period boundary.** `transactions.date` is a calendar
   day in the USER's zone. Anything compared against it comes from `server/lib/month.js`.
   *Deliberately still UTC and correct:* the `/api/fx` day cache, the nightly recurrence runner, and
   `nextMonthFirstISO()` (string arithmetic on a supplied `ym`, no clock).
3. **Mirror every server-route change in `server/scripts/devMock.js`.** The mock is what dev
   exercises. `POST /api/transactions` once shipped without `special_group_id` while the mock
   persisted it correctly — so it worked locally and failed only in production, and survived until
   Alex reported it.
4. **`position: fixed` does not work inside a page root with `animate-fade-up`.** That utility has
   fill-mode `both`, leaving a permanent identity transform which becomes the containing block. The
   add button was stranded ~7000px down the page. `QuickAddButton` portals to `<body>` for this
   reason.
5. **A passing `npm run build` does not mean working code.** Twice this session Vite built happily
   over a runtime crash (a missing import block; a temporal-dead-zone reference). Run it.
6. **Verifying UI without a login:** write a throwaway Vite entry (`client/preview.html` +
   `src/preview.jsx`) rendering the real page with the TanStack cache pre-seeded from the mock's
   actual payload — `staleTime: Infinity, retry: false` stops it ever making an authenticated call.
   Delete the harness after. Used four times; it works well.

## Files that matter
- `server/lib/month.js` — the ONE tz-aware day/month definition. 10 tests.
- `server/lib/fx.js` — currency conversion; rounds to the BASE currency. 8 tests.
- `server/lib/runningAverage.js` — the completed-months rule. 12 tests.
- `server/lib/overallBudget.js` — the ONE definition of "your total budget".
- `server/lib/special.js` — special expenses leave budget maths only while the pref is on.
- `client/src/lib/invalidate.js` — the ONE cache-invalidation list.
- `client/src/lib/format.js` — `todayISO` / `thisMonthISO`, both LOCAL. Every client "today".
- `client/src/components/ui/money-input.jsx` — every money field. Never `type="number"`.
- `server/scripts/devMock.js` — mirrors every route; keep it in step.
- Specs: `docs/superpowers/specs/2026-08-10-running-average-design.md`,
  `…-multi-currency-design.md`. Plan: `docs/superpowers/plans/2026-08-10-running-average.md`.

## Next steps (in order)

1. **Alex: live click-through** (~5 min, only he can — it's behind login). Log an expense in EUR and
   check it stores the converted figure with the original underneath; pick a group on a special
   expense and confirm the Dashboard panel updates; log something late evening and confirm it says
   "Today".
2. **Four unverified sweep leads remain.** Each is a claim from an agent that was never
   adversarially checked — treat as a lead, not a fact:
   - **`server/routes/budgets.js`** — the schema allows `period: 'weekly'` but spend is queried over
     a full month, so a weekly budget would be measured against ~4× its window. MEDIUM.
   - **`server/routes/dashboard.js:81`** — `percentOfExpenses: total / expenses` divides a
     special-EXCLUDED category total by a special-INCLUDED month total, so donut percentages
     under-report when special spend exists. MEDIUM.
   - **`server/lib/askContext.js`** — Ask Trim's budget context reportedly includes special expenses
     and ignores budget period. MEDIUM.
   - **`RecentTransactions.jsx:25`** — "Tap the + button" empty-state copy; check it still points
     somewhere true now that Transactions has its own add button. LOW.
3. **Re-run the validation sweep** once these are cleared, to catch what two passes missed.
4. Longer-standing: 9.5 encryption at rest (half-built and INERT, migration 012 NOT applied);
   Phase 8 bank sync (blocked on Enable Banking); custom domain; Supabase leaked-password toggle.

## Open questions for Alex
- None blocking. The four leads above are engineering judgement, not decisions he needs to make.

## How to resume
Start a session in this folder and say: "Read @CHAT_HANDOFF.md and continue with next step 2."

## Previous sessions
- **2026-08-11 (Phases 12b/13/14):** Currency editing after creation; the FX rate gate (a foreign
  expense with no rate was being stored as base currency — self-inflicted, caught by the second
  sweep, confirmed by two lenses); `invalidateMoney()`; one `ZERO_DECIMAL`; offline guards on
  Dashboard/Analytics/Settings (Settings would have SAVED factory defaults over real ones);
  `getSession()` catch; Ask Trim history banner; amber light-mode contrast; budget dialog naming;
  and Phase 14, the timezone fix — migration 017, 3 duplicate `monthBounds` and 16 `getUTCMonth`
  calls replaced by one lib across 7 money paths.
- **2026-08-10 (Phases 11/12):** Running average + multi-currency, migrations 016. Two validation
  sweeps run. The first lost 11 of 14 agents to an account session limit and reported `confirmed: 0`
  — which meant "nothing was verified", not "nothing is wrong"; findings were recovered from its
  journal by hand. The second completed cleanly, 11/11.
- **2026-08-08 (Phase 10):** A1–A6 + B1 + B2, migrations 014 + 015, deployed. CRON_SECRET set.
  Shared dialog scroll fix.
- **2026-07-18 (Phase 9 + 6.12a):** 9.1–9.4 deployed, migrations 010 + 011. **9.5 encryption is
  half-built and INERT** — no route imports it, `DATA_ENCRYPTION_KEY` unset, migration 012 not
  applied. Its review found 3 Critical defects, two from the plan's own example code.
- **2026-07-15 / 07-14 / 07-13:** Bank-sync design (blocked on Enable Banking); signup confirmation
  fix; v1 deploy to Vercel. Test account `trim.tester@example.com`; mock via `npm run dev:mock`.
