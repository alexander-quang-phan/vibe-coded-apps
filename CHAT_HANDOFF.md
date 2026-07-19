# Chat Handoff — updated 2026-07-18

## Goal
Phase 9 of Trim: **PLN currency, opt-in special expenses, budget pace, monthly history, and encryption at rest** (so Alex can't casually read users' finances in the Supabase dashboard). Designed, planned, and built in one session using subagent-driven development — implementer + independent reviewer per task.

## Current state
**9.1–9.4 are MERGED to `main` (`e4f7a79`) and DEPLOYED to production. 9.5 (encryption) is deliberately HALF done and gated on Alex.**

Deploy verified rather than assumed: the live client bundle contains every Phase 9 marker string (`Polish`, `Special expense`, `Monthly history`, `would typically be used`, `specialThisMonth`, `kept out of your monthly budget`), the built CSS hash matches `main` byte-for-byte, and `trim-api` shows a fresh Production deployment (the previous one was 6 days old). Migrations 010 + 011 are applied, so the features are live end-to-end.

**Still unverified: the UI click-through** (item A below). Every check was API- or bundle-level, because the app sits behind Supabase login and agents must not enter passwords.

| Task | State |
|---|---|
| 9.1 PLN currency | ✅ built, reviewed, migration 010 **applied to live DB** |
| 9.2 Special expenses (opt-in) | ✅ built, reviewed, migration 011 **applied to live DB** |
| 9.3 Budget pace | ✅ built, reviewed |
| 9.4 Monthly history | ✅ built, reviewed |
| 9.5 Encryption at rest | ⚠️ **half built, INERT on main** — crypto lib + 19 tests + migration 012 *file* + backfill *script*. No route imports it, no migration applied, nothing encrypted. The backfill needs `DATA_ENCRYPTION_KEY` (unset), so it cannot run by accident. |

**Monthly history depth (asked 2026-07-18):** it goes back **24 months**, not 5. The server caps `?months=` at 24 (`analytics.js:20`) and Analytics requests all 24; `MonthlyHistory` then trims *leading* months with no data. Alex currently sees ~5 rows simply because the Supabase project dates from 2026-04-24 — the table grows on its own each month.

Verified on one running mock API together: currency PLN, `specialThisMonth` 180, `pace {target 900, spent 1173.07, delta −273.07}`, 24 analytics buckets all carrying `special`. Client build passes; every server file syntax-clean.

## What Alex still has to do

**A. Click-through test on the LIVE site (5 min, only you can).** Agents can't get past Supabase login. On https://trim-budget.vercel.app confirm: Settings → currency PLN shows `zł`; Settings → **Special expenses** toggle on → Quick-Add's "Add a note or change the date" area shows a ⭐ toggle → log one → Dashboard hero shows a Special chip and the budget bars *don't* move → Transactions row star/unstar → Dashboard pace line inside "Can I afford this?" → Analytics → Monthly history → tap an old month. If anything is missing, `vercel rollback` is one command.

**B. The encryption decision (9.5).** The remaining half is genuinely risky and needs you:
1. Generate the key yourself: `openssl rand -base64 32` → put in `server/.env` as `DATA_ENCRYPTION_KEY`, add to Vercel, **and back it up in `~/Keys/`**. Losing this key = every user's financial data is unrecoverable. (Agents deliberately did not generate or handle it.)
2. Then a session can: apply migration 012 (additive, safe) → run `encrypt-backfill.mjs --dry-run` → run it for real → sweep the ~12 routes to encrypt-on-write/decrypt-after-fetch → click-test → **only then** migration 013, which irreversibly drops the plaintext columns.

## Key decisions (and why)
- **Server-side encryption, not end-to-end.** E2E would kill Ask Trim, the NL parser, subscription detection and the planned bank sync, and a forgotten password would destroy the data. Honest limit, recorded in the spec: Alex holds the key, so this stops *casual* viewing (dashboard, SQL console, backups all show ciphertext) — it is not protection from a determined operator.
- **Special expenses are opt-in and off by default** (Alex's call): "for others maybe girlfriend's expenses would still go in the same monthly budget". When the pref is off, flags go dormant and every transaction counts normally.
- **Special expenses are excluded from budget math only** — still counted in hero cash flow, transaction list and analytics, so the numbers stay honest.
- **Pace is plain arithmetic** (budget × day ÷ days-in-month), so unlike the month-end projection it needs no cold-start guard and shows from day 1. Amber when ahead of pace, never red.
- **Phase 9 took migrations 010–013**; Phase 8's (unbuilt) bank-sync spec DDL shifts to 014+. Noted in BUILD_PLAN Phase 8.

## The thing worth reading twice
The crypto review (run on the most capable model, deliberately) found **three Critical defects, two of which came from the plan's own example code** — proof that a plan being approved doesn't make its code correct:
1. The backfill would have **infinite-looped against production**: it paged on `.is(first_enc, null)` and expected its own write to remove the row, but a NULL plaintext gets written as NULL and re-matches forever. `user_stats.monthly_limit` and `subscription_overrides.display_name` are both nullable — it would have hung mid-run, leaving the database half-encrypted.
2. The "verification" gating the irreversible drop **never read the database** — it compared a value against the thing it had just encrypted in memory, blind to exactly the storage-layer failures migration 013 bets on.
3. `decryptField` **accepted 4-byte auth tags**, cutting forgery cost from 2^128 to 2^32 for an attacker who can write to the DB — the precise threat at-rest encryption exists for.

The spec and plan were corrected in `fc420b0` so a future session rebuilding from them can't reintroduce these.

## Files that matter
- `docs/superpowers/specs/2026-07-17-pln-privacy-history-pace-special-design.md` — the spec (+ PDF). Corrected post-review.
- `docs/superpowers/plans/2026-07-17-phase9-pln-privacy-history-pace-special.md` — step-by-step plan (+ PDF). Task 5 is the encryption runbook.
- `BUILD_PLAN.md` Phase 9 — paste-ready prompts for 9.1–9.5.
- `server/lib/special.js` — the pure `excludeSpecial`/`sumSpecial` helpers all budget math routes share.
- `server/lib/crypto.js` + `server/test/crypto.test.js` — AES-256-GCM, per-user HKDF keys. `cd server && npm test`.
- `server/scripts/encrypt-backfill.mjs` — **not yet run**.
- `.superpowers/sdd/progress.md` — per-task ledger incl. deferred minor findings.

## Next steps (in order)
1. Alex: click-through A above on the live site.
2. **Task 6.12 (recurring transactions executor) — started 2026-07-18, see below.**
3. Whenever 9.5 resumes: follow plan Task 5, steps 1 → 8, in one session, stopping for explicit confirmation before migration 013.

## Task 6.12 — recurring transactions executor (in progress 2026-07-18)

A full design was already parked on branch `docs/task-6.12-spec-unbuilt` (commit `99d3bfa`, written 2026-07-12). Those doc edits describe the feature **as if shipped — no code exists**. Design decisions already made there and worth keeping:
- Separate **`recurrences`** table (user_id, category_id, type, amount, description, interval monthly|weekly, next_run_at, last_run_at, cancelled_at) + `transactions.recurrence_id` FK.
- Opt-in lives in QuickAddDialog's existing hidden "note/date" area, **expense-only**, so the 3-tap path stays clean.
- "Recurring" pill on /transactions rows; manual recurrences surface on **/subscriptions** with a "Manually marked" pill — no second management surface.
- Auto-detector skips transactions carrying `recurrence_id` so manual + detected don't double-count.
- Cancel = soft (`cancelled_at`), stops future creations, keeps history.
- Idempotency via optimistic claim: `UPDATE ... WHERE next_run_at = <oldDate>`, so a double run is a no-op.

**The one stale decision:** that spec specifies **Railway cron**, but Trim moved to Vercel on 2026-07-13 and no cron is configured (`server/vercel.json` has rewrites + `maxDuration: 60` only). Verified 2026-07-18: **Vercel Cron on Hobby allows 2 jobs at once-per-day each** — enough for the single nightly 03:00 UTC job this needs. (The "no reliable cron on Vercel" note from 2026-07-15 was about *bank sync*, which needs frequent polling — a different shape of problem.) Alex to confirm venue before coding.

## Open questions for Alex
- Finish encryption now, or merge the four shipped features first? (Recommendation: merge 9.1–9.4 and deploy — they're verified and independent — then do 9.5 as its own session with the key in hand.)
- Carried over from 2026-07-15: Phase 8 (bank sync) still blocked on the Enable Banking account; custom domain and the Supabase leaked-password toggle still pending.

## How to resume
Start a session in this folder and say: "Read @CHAT_HANDOFF.md and continue with next step 2."

## Previous sessions
- **2026-07-15 (bank sync + billing design):** Validation + design only, merged to main. Stripe can't read card purchases — bank sync needs Enable Banking (open banking); Stripe is billing-only. Spec: `docs/superpowers/specs/2026-07-15-bank-sync-and-billing-design.md`, tasks in BUILD_PLAN Phase 8, blocked on Alex creating the Enable Banking account.
- **2026-07-14 (signup fix):** Email confirmation ON made `signUp()` return no session/no error; Signup.jsx now shows a "Check your inbox" fallback. Alex turned confirmation off everywhere.
- **2026-07-13 (v1 deploy):** Deployed client+API to Vercel free tier. Test account `trim.tester@example.com` / `trim-test-1234`; mock API via `cd server && npm run dev:mock`.
