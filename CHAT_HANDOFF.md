# Chat Handoff — updated 2026-07-17

## Goal
Phase 9 of Trim: **PLN currency, opt-in special expenses, budget pace, monthly history, and encryption at rest** (so Alex can't casually read users' finances in the Supabase dashboard). Designed, planned, and built in one session using subagent-driven development — implementer + independent reviewer per task.

## Current state
**9.1–9.4 are built, reviewed and committed. 9.5 (encryption) is deliberately HALF done and gated on Alex.** Everything is on branch `claude/budgeting-pln-privacy-features-43da8e` in the worktree — **nothing is merged to `main`, so nothing is deployed.**

| Task | State |
|---|---|
| 9.1 PLN currency | ✅ built, reviewed, migration 010 **applied to live DB** |
| 9.2 Special expenses (opt-in) | ✅ built, reviewed, migration 011 **applied to live DB** |
| 9.3 Budget pace | ✅ built, reviewed |
| 9.4 Monthly history | ✅ built, reviewed |
| 9.5 Encryption at rest | ⚠️ **half built** — crypto lib + tests + migration 012 *file* + backfill *script*. Nothing applied, nothing encrypted, no routes changed. |

Verified on one running mock API together: currency PLN, `specialThisMonth` 180, `pace {target 900, spent 1173.07, delta −273.07}`, 24 analytics buckets all carrying `special`. Client build passes; every server file syntax-clean.

## What Alex still has to do

**A. Click-through test (5 min, only you can).** Every agent verification was API-level — the UI is behind Supabase login and agents must not enter passwords. Please start the app and confirm: Settings → currency PLN shows `zł`; Settings → **Special expenses** toggle on → Quick-Add's "Add a note or change the date" area shows a ⭐ toggle → log one → Dashboard hero shows a Special chip and the budget bars *don't* move → Transactions row star/unstar → Analytics → Monthly history → tap an old month.

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
1. Alex: click-through A above; tell the next session anything that looks wrong.
2. Alex: decide on 9.5 — either finish encryption (generate key first) or merge 9.1–9.4 now and do encryption later. **9.1–9.4 are independently mergeable**; encryption does not block them.
3. Merge `claude/budgeting-pln-privacy-features-43da8e` → `main`, then `/deploy`.
4. Whenever 9.5 resumes: follow plan Task 5, steps 1 → 8, in one session, stopping for explicit confirmation before migration 013.

## Open questions for Alex
- Finish encryption now, or merge the four shipped features first? (Recommendation: merge 9.1–9.4 and deploy — they're verified and independent — then do 9.5 as its own session with the key in hand.)
- Carried over from 2026-07-15: Phase 8 (bank sync) still blocked on the Enable Banking account; custom domain and the Supabase leaked-password toggle still pending.

## How to resume
Start a session in this folder and say: "Read @CHAT_HANDOFF.md and continue with next step 2."

## Previous sessions
- **2026-07-15 (bank sync + billing design):** Validation + design only, merged to main. Stripe can't read card purchases — bank sync needs Enable Banking (open banking); Stripe is billing-only. Spec: `docs/superpowers/specs/2026-07-15-bank-sync-and-billing-design.md`, tasks in BUILD_PLAN Phase 8, blocked on Alex creating the Enable Banking account.
- **2026-07-14 (signup fix):** Email confirmation ON made `signUp()` return no session/no error; Signup.jsx now shows a "Check your inbox" fallback. Alex turned confirmation off everywhere.
- **2026-07-13 (v1 deploy):** Deployed client+API to Vercel free tier. Test account `trim.tester@example.com` / `trim-test-1234`; mock API via `cd server && npm run dev:mock`.
