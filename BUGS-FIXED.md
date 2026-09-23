# Bugs fixed in Trim

The record of what has already broken here. **Read this before writing or reviewing code in this
project.** Reintroducing a bug listed below is a P0.

After fixing any real bug, append one row: what it was, why it mattered, how it was fixed.

---

## 2026-09-23 — The audit P3 sweep: five defects that each had a bound, a guard or a clock in the wrong place

Filed as one entry because they share one shape: a rule existed, and something stood outside it.

**1. A bound on an input is not a bound on what's derived from it.**
`createSchema` capped `amount` and `foreign.originalAmount` at 1,000,000,000, but `fxRate` was
only `positive().finite()`. The stored figure is DERIVED (`originalAmount x fxRate`) and was
checked only for `<= 0`, so `1e9 x 100` sailed through and `numeric(14,2)` accepted it. One such
row skewed every derived figure on the account — dashboard totals, budget percentages,
projections, the Ask Trim context. *Fixed:* `MAX_AMOUNT` is now one constant, and every
`convertToBase` result (4 call sites, POST and PATCH) goes through `amountRangeError`, which
enforces both ends. The lower bound is kept and separately tested.

**2. A guard gated on the wrong condition never fires.**
PATCH's category/type check sat inside `if (parsed.data.categoryId)` AND was additionally gated
on `parsed.data.type &&`. So `PATCH {"type":"income"}` alone skipped it entirely and left an
income row filed under an expense category — which POST refuses outright, and which no CHECK
constraint backs up. *Fixed:* it now guards the RESULTING state (`effectiveType`,
`effectiveCategoryId`), the same pattern the adjacent `isSpecial` guard already used.

**3. A calendar day belongs to the user, not the server.**
`routes/transactions.js` says exactly that at its own `todayISO`, and every route resolves month
bounds through `lib/userZone.js` — but the nightly sweep stamped `date` from the server's UTC day
for everyone. For a user west of UTC the 03:00 UTC run is still the previous local day, so a
month-end recurrence landed in the wrong budget month. Invisible in London; wrong in the
Americas. *Fixed:* the sweep groups rows by user, resolves each user's own day via
`dayInZone(theirZone)`, and widens the DB filter by one day so a user EAST of UTC is not missed
either. Tested with two zones 25 hours apart, which can never share a calendar day.

**4. A migration that cannot replay is not a migration.**
`009` revoked EXECUTE on `public.rls_auto_enable()`, a function no migration in this repo ever
creates — it was made out-of-band in the live project. On a from-scratch replay PostgreSQL raised
42883, and because the Supabase SQL editor wraps a pasted batch in ONE transaction, the
`handle_new_user()` revoke on the line above rolled back with it. A rebuilt database ended up in
exactly the state 009 exists to prevent. *Fixed:* the second revoke is wrapped in a `do $$ …
exception when undefined_function` block. Verified against a real PostgreSQL both ways — it
commits when the function is absent (and the first revoke survives), and still genuinely revokes
when it is present.

**5. Guards must read decoded rows; responses must not return them raw.**
Two latent encryption-phase defects, both inert at phase `off` and both live the moment the
cutover happens. The protected-category DELETE guard compared `cat.name` against
`PROTECTED_DEFAULT_NAMES` without decoding first — past `off` the plaintext column is gone, so it
compared `undefined`, failed open, and would have let the user delete the reassign safety net.
And `/categories` (x3) plus `/ask/history` and the two SSE frames returned `decodeRow(s)` output
directly, shipping the codec's own `*_enc` and `user_id` columns to the browser. *Fixed:* decode
before the guard; `presentRow`/`presentRows` with the route's own column list on the way out, as
`transactions.js` and `budgets.js` already did.

**Also this round, not defects:** `*.pem` added to `.gitignore`; the real Supabase project ref
moved out of `DEPLOY.md`, the Phase 9.5 runbook and the tracked `DEPLOY.pdf` into a gitignored
`DEPLOY.local.md` (this repo is public); the false "intentionally NOT committed" header on
`server/scripts/spike-enablebanking.mjs` corrected to say the opposite, loudly; `npm audit fix`
applied (server 3 advisories -> 1 moderate, LifeChat 4 -> 0); both stale worktrees removed, which
also deleted two duplicate on-disk copies of the service-role key (branches kept, nothing lost).

**Coverage added:** `server/test/routeMountTable.test.js` boots the real app and asserts every
`/api/*` mount refuses an unauthenticated request, with `/api/health` and `/api/cron` as the only
allowlisted exceptions, plus a drift test that fails if `index.js` gains a mount this file does
not list. Both halves were verified by deliberately breaking them. Suite: **507 passing, 0
skipped** (the 13 real-PostgreSQL tests silently stopped running when `npm audit fix` pruned the
`--no-save` `pg`/`embedded-postgres` packages — reinstalled; a green total is not proof the whole
suite ran).

---

## 2026-09-23 — A valid token was treated as an invited account (open signup → anyone could spend the Anthropic key)

**What it was.** `requireAuth` verified a Supabase JWT impeccably — signature via the project's
JWKS, issuer, audience, expiry, `sub` present — and then asked nothing about *who* the token
belonged to. Supabase signup is open, email confirmation is **off** (SECURITY.md), and the anon key
is public in the client bundle by design. So anyone on the internet could POST to the project's
signup endpoint, receive a valid `access_token` instantly with no mailbox access, and stand on all
14 authenticated mounts as a full principal.

**Why it mattered.** `/api/ask` spends `ANTHROPIC_API_KEY` on every turn, and its 20/hour cap is
keyed on `req.user.id` — so signing up again reset the bucket. That is uncapped billing on Alex's
key, plus unbounded row growth on a free-tier project (each signup fires `handle_new_user()`,
inserting `user_stats` and 12 categories). It was **not** a data breach: every query was still
correctly scoped by `req.user.id`, so each fake account saw only its own empty data. Checked before
fixing: `auth.users` held exactly the 7 known users, latest signup 16 Jul, zero in the preceding 30
days, and `ask_messages` had 4 rows ever from 1 user. A real hole that nobody had found.

**How it was fixed.** An `ALLOWED_EMAILS` allowlist, consulted after the `sub` guard, returning
**403** — the credential is genuine, the account simply isn't invited, so retrying with a fresh
token will never help. Comparison is trimmed and lower-cased on both sides. It fails closed **at
boot**, the same way `SUPABASE_URL` and `CRON_SECRET` do: an unset or empty list makes the server
refuse to start rather than admit everyone. Covered by `server/test/auth.test.js` (new — nothing in
the suite had ever loaded the real middleware, because every route suite mounts behind a stub that
injects `req.user`).

**The operational cost, deliberately accepted.** Fail-closed-at-boot means `ALLOWED_EMAILS` must be
set in the `trim-api` Vercel env *before* this reaches `main`, or the API will not start at all. A
loud outage was judged better than a silent open door. It must list **every** real user, not just
Alex, or the other six are locked out.

---

## 2026-09-23 — The rate limits did not exist in production

**What it was.** `globalLimiter` and `askLimiter` both used `express-rate-limit`'s default
`MemoryStore` — no `store:` option anywhere in the server. But the live deployment is a **Vercel
serverless function**, not the long-lived Railway process the limiters implicitly assumed.

**Why it mattered.** Each serverless instance has its own memory, so the counters were per-instance:
"20 chats/hour" was really 20 × however many instances were warm, and a caller spacing requests out
past instance recycling was never limited at all. The cost ceiling documented in SECURITY.md on a
*paid* API simply did not hold. This compounded the auth hole above.

**How it was fixed.** The `/api/ask` ceiling is now counted in Postgres — `ask_messages` rows with
`role='user'` in the trailing hour — which every instance shares by construction and which survives
recycling. One indexed query, no new dependency. It runs **before** the user-message insert, so a
rejected turn leaves no stray row and cannot inflate the caller's own quota. `askLimiter` stays as a
cheap in-memory first line. Verified by running the equivalent count against the live database: the
`role='user'` filter discriminates correctly (2 of 4 rows).

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
4. **Verifying is not authorising.** A valid signature proves our project issued the token, not that
   the holder was invited. Signup is open: anything that admits a principal must also consult
   `ALLOWED_EMAILS`.
5. **In-process state does not survive serverless.** Anything held in memory — rate limits, caches,
   locks — is per-instance and resets on recycle. If a limit must actually hold, count it in Postgres.
6. **A bound on an input is not a bound on what's derived from it.** The zod schema caps `amount`,
   but a figure computed from `originalAmount × fxRate` escapes that cap unless re-checked. Still
   open at `routes/transactions.js:218` and `:478`.

## Traps that have not bitten yet (found by audit, 2026-09-22)

Recorded so they are not rediscovered the hard way. Most of the original list became the
2026-09-23 fixes above; what remains is below. Full detail lives outside this **public** repo, in
`../SECURITY-AUDIT-2026-09-22.md`; this file deliberately records the invariant, not an exploit.

- **The server holds the `service_role` key, so RLS protects nothing.** Every query must be scoped
  by `req.user.id` in application code — there is no database backstop. The one deliberate exception
  is the nightly cron sweep (`routes/cron.js`).
- **Guards that read a column must run *after* decoding.** Past `ENCRYPTION_PHASE=off` a plaintext
  column may not exist, so a check against `row.name` compares against `undefined` and fails open.
- **Return `presentRow`/`presentRows`, never a raw decoded row** — the codec adds `*_enc` and
  `user_id` for its own use, and returning the row wholesale ships them to the browser.

- **Migrations must replay cleanly from scratch.** A statement naming an object no migration
  creates aborts the whole batch in the Supabase SQL editor, silently skipping the statements
  before it — and disaster recovery depends on that replay. `009` was fixed; the directory is
  still not a complete description of the live database, because `rls_auto_enable()`'s body
  exists only in the live project.
