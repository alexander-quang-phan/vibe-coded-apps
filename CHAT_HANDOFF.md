# Chat Handoff — updated 2026-07-15

## Goal
Add the two features that make Trim shareable-beyond-friends and sellable: (1) purchases from users' existing debit/credit cards appear automatically (killing manual entry — the #1 budgeting-app complaint), and (2) a Stripe payment layer so users can eventually pay for Trim. This session was **validation + design only** — Alex builds later, one task per session.

## Current state
**Designed, approved, committed — zero feature code written (by design).** Commit `75f775b` on worktree branch `claude/stripe-payment-integration-d042da` — **NOT merged to `main`; nothing deploys until it is.**

- Full design spec: `docs/superpowers/specs/2026-07-15-bank-sync-and-billing-design.md` (+ PDF next to it for Alex).
- BUILD_PLAN.md: new **Phase 8** section, tasks 8.A0–8.C, each with a paste-ready chat prompt.
- FEATURES.md: "Planned — Trim Premium" section.
- App itself untouched; live site unaffected.

## Key decisions (and why)
- **Stripe does NOT do transaction import** — validation's key correction. Stripe only processes payments *to* businesses; reading users' card purchases requires an **open banking provider**. Stripe's role in Trim = billing only.
- **Enable Banking is the UK bank-data provider** (Alex approved 2026-07-15): the classic indie option GoCardless/Nordigen **closed to new signups Jul 2025**; Plaid Europe is enterprise-sales-only; Stripe Financial Connections is US-accounts-only. Enable Banking: self-serve, free sandbox, free "restricted production" (whitelist own real accounts) — fits the friends-testing phase. All verified by web search 2026-07-15.
- **Target markets: UK first, US later (provider adapter layer), Vietnam unsupported** (no aggregator covers VN consumer banks — VND users keep manual logging with friendly messaging).
- **Freemium, but sync free during testing** (Alex): manual logging free forever; bank sync becomes ~£3.99/mo "Trim Premium" later. `requirePremium` middleware built from day one but disabled via `PREMIUM_ENFORCED=false` — flipping to paid is config, not a rebuild.
- **Bank sync before billing** (Alex): prove the risky/valuable part with his own real bank while free; add Stripe before sharing widely.
- **Review inbox preserves the streak loop**: auto-import would kill log-daily gamification, so imported transactions land in a 1-tap "New from your bank" inbox; first review of the day fires `applyLogEvent` once. Bulk imports NEVER award XP (a 90-day backfill would mint fake streaks).
- **Naming: "billing/plan/premium", never "subscriptions"** — that word is taken by the recurring-merchant detection feature.
- Gotchas baked into the spec: Stripe webhook needs `express.raw` mounted BEFORE the global `express.json` in `server/index.js`; Vercel serverless = 60s cap + no reliable cron → sync-on-app-open with 6h server throttle; single-currency rule → non-matching-currency accounts refused (no FX).

## Files that matter
- `docs/superpowers/specs/2026-07-15-bank-sync-and-billing-design.md` — THE spec (schema DDL 010/011, adapter interface, routes, security addendum, phased tasks). PDF alongside. Newest.
- `BUILD_PLAN.md` — Phase 8 tasks with chat prompts (the menu for the build sessions).
- `FEATURES.md` — planned-features section added.
- Plan file (approved): `~/.claude/plans/i-want-to-add-eager-wadler.md`.

## Next steps (in order)
1. **Merge this branch to `main`** (docs only, safe): from the main checkout, merge `claude/stripe-payment-integration-d042da`.
2. **Alex reads the PDF** and confirms/adjusts the £3.99/mo price and phasing.
3. **Run task 8.A0** (paste its chat prompt from BUILD_PLAN.md Phase 8): Enable Banking account + spike against Alex's own bank. It's the go/no-go gate and answers the 5 open items in spec §9.
4. Then 8.A1 → 8.A2 → 8.A3 (bank sync), 8.B1 → 8.B2 (Stripe), one session each.

## Open questions for Alex
- Final price: £3.99/mo / £29/yr suggested (Snoop is £5.99) — confirm after 8.A0 reveals Enable Banking's real production pricing.
- Which UK bank is Alex's own (for the 8.A0 whitelist test)?
- Carried over: custom domain? Supabase Site URL + leaked-password toggle (2-min dashboard task from 2026-07-14) still pending?

## How to resume
Start a new session in this folder and say: "Read @CHAT_HANDOFF.md and continue with next step 1."

## Previous sessions
- **2026-07-14 (signup fix + email confirmation off):** Root-caused "Create account does nothing" — email confirmation ON made `signUp()` return no session/no error; Signup.jsx now shows a "Check your inbox" fallback panel. Alex turned confirmation OFF everywhere (built-in sender ~2 emails/hr + spam-foldering; revisit with custom SMTP e.g. Resend before re-enabling). Stuck accounts recovered. Live site verified end-to-end; merge `b73ceca`. Unmerged branch `claude/affectionate-shirley-83720f` (Subscriptions page) likely superseded — verify then merge/delete.
- **2026-07-13 (v1 deploy):** Deployed client+API to Vercel free tier (`trim-budget` / `trim-api-jade`); serverless Express entrypoint; chose Vercel over Railway (CLI already authed, free). Validation pass fixed Ask Trim SSE abort bug; built 6.4 affordability + 6.5 simple mode (falsely ✅ before); 6.A dashboard slim-down; 6.9 merchant suggestions; PulseStrip UI pass. Test account `trim.tester@example.com` / `trim-test-1234`; mock API via `cd server && npm run dev:mock`.
- **2026-07-12 (pre-deploy):** Full feature validation with mock API; Supabase restored from free-tier pause + migrations 008/009; Railway deploy prep; mobile/light polish; memory notes on Supabase pausing + docs-drift.
