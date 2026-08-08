# Chat Handoff — updated 2026-08-08

## DUAL-AGENT BATON  (both models: update this the MOMENT you finish work)
- Current stage:  no loop active — Phase 10 Batch A was ordinary feature work, single-model by design
- Model A is:     not yet set — Alex chooses at the next kickoff (Codex or Claude Code)
- Up next:        n/a — engage the loop only for a big/risky change; 9.5 encryption is still the prime candidate
- Last actor did: Phase 10 **Batch A built, verified and committed** on branch `claude/phase-10-batch-a` (needs merging to `main`)
- Next must:      Alex merges + deploys Batch A, then does the 3-step "All Expenses" cleanup below
- Last verdict:   —
- Handoff log:
  - 2026-07-23 Claude Code: baton added — Trim retrofitted into the dual-agent workflow
  - 2026-08-08 Claude Code: Phase 10 Batch A (7 daily-use items, batch 1 of 2)

## Goal
Seven things Alex hit while using Trim daily: notes hidden behind a dropdown in Quick-Add, accidental
category taps, no arbitrary emoji, "All Expenses" not covering all expenses, no way to see the monthly
total with/without special expenses, **no way to type decimals on his phone**, and finishing Task 6.12.
Split into two batches at Alex's request: **Batch A needs nothing from him**, Batch B needs SQL + a secret.

## Current state

**Batch A is DONE, verified in a running browser, and committed to `claude/phase-10-batch-a` (`8ab3c6b`).
It still needs merging to `main` — nothing deploys until it's there.** Batch B is not started.

| Item | State |
|---|---|
| A1 decimals on phone | ✅ `MoneyInput` replaces all 7 money fields |
| A2 note always visible + two-tap category | ✅ |
| A3 any-emoji picker (categories + goals) | ✅ ~1,135 emoji, search, paste field |
| A4+A5 overall budget + pace gap/per-day | ✅ no migration needed |
| A6 incl./excl. special toggle | ✅ client-only |
| B1 special-expense groups | ⬜ not started (needs migration 015) |
| B2 Task 6.12b client half | ⬜ not started (needs migration 014 + `CRON_SECRET`) |

Verified, not assumed: client build passes, 29/29 server tests pass, every server file parses, and each
item was **click-tested in a real browser** against `npm run dev:mock` — the decimal fix by typing
`12,50` and getting `12.50`, the two-tap guard by confirming exactly one `POST /api/transactions` fired
across four chip taps, the emoji rules by curl (`hack` → 400, 👨‍👩‍👧‍👦 → 201), and the budget maths by
setting an overall budget and watching the "total" stop being 1200+1550.

Agents still can't log into the live site (Supabase password) — the live click-through is Alex's.

## Two things that were not what they looked like

**1. "All Expenses" does not exist in Trim.** Zero references repo-wide. Alex had created a *category*
by that name to fake an overall cap. Because every "total" in the app was `SUM(amount_limit)` over the
category budgets, his £1200 umbrella was **added on top of** the categories it was meant to contain
(£1200 + Food £300 + … = a phantom total). There is now a real overall monthly budget.

**2. "Can't add decimals on phone" was a real bug**, not a preference. Every money field was
`<input type="number">` bound to controlled React state. A number input returns `''` from `.value` for
anything that isn't yet a complete number — so typing `"12."` set the state back to `""` and the
separator vanished, and a comma was rejected outright. Alex's currency is PLN, and **the iOS decimal
key in a `pl-PL` locale IS a comma** — so decimals were literally impossible for him. Proved in the
browser before fixing: `type="number"` reports `""` for both `"12."` and `"12,50"`.

## Three defects found underneath the requested work (all fixed)
1. `projections.js` paired a budgeted-only *target* with an all-categories *actual*, so budgeting a
   subset of categories read as permanently "ahead of pace" — and **disagreed with
   `affordability.js`** (which filtered correctly) on the same Dashboard screen. Both now share
   `server/lib/overallBudget.js`, with 11 unit tests over the four combinations.
2. Emoji validation was `z.string().max(8)`, counting UTF-16 code units: it rejected real emoji
   (👨‍👩‍👧‍👦 is 11 units) while accepting `"hack"` and `"🍔🍔🍔🍔"`. Now exactly one pictographic
   grapheme, with flags and keycaps explicitly allowed (neither is `Extended_Pictographic`).
3. *(Batch B, not yet fixed)* `lib/subscriptions.js:10` and `SubscriptionRow.jsx:16` collapse every
   non-`annual` cadence to "Monthly", but 6.12a's server emits `weekly`.

## ⚠️ Deployment hazard worth knowing
`claude/task-6.12-recurring` (`ff2509b`, `d81693f`) holds the 6.12a **server** half. Its
`GET /api/subscriptions` reads the `recurrences` table and selects `transactions.recurrence_id`, so
**merging that branch without first applying migration 014 will 500 the Subscriptions page in
production.** Batch A was deliberately branched from `main`, not from that branch, so it carries no
such dependency and can ship on its own today.

## Key decisions (and why)
- **Two batches** (Alex's call): Batch A = zero setup from him; Batch B = the two items needing SQL.
- **Overall budget reuses `user_stats.monthly_limit`** (migration 008) rather than a new column — it
  was already the right field, just gated behind `simple_mode`. **No migration.** When set it *is* the
  total and all expense spend counts against it; with none set, the old sum-of-categories behaviour
  returns exactly.
- **Two-tap arms, doesn't confirm-dialog** (Alex chose this over a separate Log button): first tap
  fills the chip and says "Tap again", second tap on the *same* chip logs. Tapping a different chip
  only moves the arm. Deliberately does **not** disarm on note edits — people type the note after.
- **Over budget shows the overage and no per-day number** (Alex chose this when he spotted that
  `(budget − spent) ÷ days left` goes negative): "You're £155 over your £900 budget — nothing left for
  the last 24 days."
- **Own emoji picker, no npm dependency** — emoji-mart is 150–300KB with its own styling to fight.
  The catalogue is dynamic-imported into a separate 26KB chunk, and the paste field covers everything
  not in it (on a phone that's the emoji keyboard, so skin tones and every flag are reachable).
- **A6 needed no server change** — `/api/dashboard` already returns `expenses` *including* special
  plus `specialThisMonth`, so excluding is exact subtraction.
- **Alex's "All Expenses" category is NOT auto-migrated** — it's his data; he does the 3 steps below.

## Files that matter
- `~/.claude/plans/i-would-like-to-snappy-willow.md` — the approved plan for both batches. **Batch B's
  full design, including the exact migration 015 SQL, is in there.**
- `server/lib/overallBudget.js` — the ONE definition of "your total budget". Read this before touching
  pace, affordability or budgets.
- `server/test/overallBudget.test.js` — 11 tests, the four combinations + the over-budget floor.
- `server/lib/emoji.js` + `client/src/lib/emoji.js` — the grapheme rule, kept in sync by hand.
- `client/src/components/ui/money-input.jsx` — every money field goes through this now.
- `client/src/components/PaceLine.jsx` — was duplicated byte-for-byte in two components before.
- `client/src/lib/emojiData.js` — the catalogue; dynamic-imported only.
- `BUILD_PLAN.md` → **Phase 10** — Batch A ticked, Batch B specified.

## Next steps (in order)
1. **Alex: merge `claude/phase-10-batch-a` into `main` and deploy** (`/deploy` skill). It's one commit,
   branched cleanly off `main`, no SQL, no env vars.
2. **Alex: the "All Expenses" cleanup** (2 min, only he can — it's his data):
   1. **Budgets** → delete the budget attached to "All Expenses".
   2. **Budgets** → set the new **Overall monthly budget** card to his real monthly total (e.g. £1200).
   3. **Settings → Categories** → delete "All Expenses". If it holds transactions, the existing
      reassign dialog asks where to move them.
3. **Alex: live click-through** — Quick-Add note visible without expanding; tap a category once
   (nothing logs) then again (logs); type `12,50` on his phone and get 12.50; Settings → Categories →
   search an emoji; Dashboard "incl./excl. special" chip.
4. **Batch B** when he's ready — he must first run migration 014 *and* 015 and generate `CRON_SECRET`
   himself (`openssl rand -base64 32`, set on trim-api + local `server/.env`).
5. Still open from Phase 9: the 9.5 encryption decision (see Previous sessions).

## Open questions for Alex
- Batch B ordering: B2 (6.12b recurring) before B1 (special groups), or the reverse? B2 unblocks
  already-written server code; B1 is the one he described with more feeling ("September 2026 Paris
  holiday"). No dependency either way.
- Carried over: Phase 8 (bank sync) blocked on the Enable Banking account; 9.5 encryption still needs
  him to generate and back up `DATA_ENCRYPTION_KEY`; custom domain and the Supabase leaked-password
  toggle still pending.

## How to resume
Start a session in this folder and say: "Read @CHAT_HANDOFF.md and continue with next step 4."

## Previous sessions
- **2026-07-18 (Phase 9 + 6.12a):** 9.1–9.4 (PLN, opt-in special expenses, budget pace, monthly
  history) merged to `main` (`e4f7a79`) and deployed; migrations 010 + 011 applied to the live DB.
  **9.5 encryption is half-built and INERT on main** — crypto lib + 19 tests + migration 012 file +
  backfill script, but no route imports it and `DATA_ENCRYPTION_KEY` is unset, so it can't run by
  accident. Alex must generate and back up that key himself before it resumes; the runbook is
  `docs/superpowers/plans/2026-07-17-phase9-…md` Task 5, stopping for explicit confirmation before
  migration 013 (irreversible plaintext drop). The crypto review found **3 Critical defects, two from
  the plan's own example code** (an infinite-looping backfill against production; a "verification"
  that never read the DB; `decryptField` accepting 4-byte auth tags) — corrected in `fc420b0`.
  Task 6.12a (recurring transactions **server** half) built on `claude/task-6.12-recurring` — see the
  deployment hazard above. Monthly history goes back 24 months, not 5; Alex sees ~5 rows only because
  the Supabase project dates from 2026-04-24.
- **2026-07-15 (bank sync + billing design):** Design only, merged. Stripe can't read card purchases —
  bank sync needs Enable Banking (open banking); Stripe is billing-only. Blocked on Alex's account.
- **2026-07-14 (signup fix):** Email confirmation ON made `signUp()` return no session/no error;
  Signup.jsx now shows a "Check your inbox" fallback. Alex turned confirmation off everywhere.
- **2026-07-13 (v1 deploy):** Client + API on Vercel free tier. Test account
  `trim.tester@example.com` / `trim-test-1234`; mock API via `cd server && npm run dev:mock`.
