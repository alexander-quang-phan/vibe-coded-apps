# Trim — Architecture

> Scaffold/architecture prompt captured verbatim-ish so any future session can rebuild or extend without losing intent. Paired with FEATURES.md (product vision).

## Stack (locked in)

- **Client:** React 18 + Vite + React Router v6 + Tailwind CSS + shadcn-style primitives (Radix under the hood). TanStack Query v5 for data. React Hook Form + Zod for forms. Recharts for charts. Sonner for toasts. canvas-confetti for celebrations.
- **Server:** Node.js 20+ with Express 4, ESM (`"type": "module"`). Zod for input validation. `jose` for JWT verify (JWKS-based, supports asymmetric signing). helmet + cors + express-rate-limit.
- **DB + Auth:** Supabase (managed Postgres + Auth + Row Level Security). ES256 JWTs verified via JWKS.
- **Hosting:** Railway (one service for server; client served via Vite build / Railway static).

## Repo layout

```
/
├── client/                  # React + Vite (browser)
│   ├── src/
│   │   ├── components/      # UI primitives + composed components
│   │   ├── components/ui/   # shadcn-style primitives (Button, Dialog, Select, etc.)
│   │   ├── hooks/           # useAuth, useApi
│   │   ├── lib/             # api.js, format.js, confetti.js, utils.js, supabase client,
│   │   │                    #   emoji.js (single-emoji check), emojiData.js (dynamic-imported catalogue)
│   │   ├── pages/           # Dashboard, Transactions, Budgets, Analytics, SavingsGoals, Subscriptions, Settings, Login, Signup
│   │   ├── App.jsx          # Auth-aware shell + nav + theme toggle + Ask Trim chatbot
│   │   └── main.jsx         # QueryClient + AuthProvider + Router
│   ├── index.html           # Sets `class="dark"` and reads localStorage 'trim-theme'
│   ├── tailwind.config.js   # HSL CSS variable token mapping
│   └── .env                 # VITE_API_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
│
├── server/                  # Express API (the ONLY thing that touches service-role Supabase)
│   ├── index.js             # App composition, middleware, route mounts
│   ├── lib/supabase.js      # Service-role client (server-only)
│   ├── lib/gamification.js  # Pure streak/XP/shield/level logic
│   ├── lib/subscriptions.js # Pure recurring-charge detection on a tx list
│   ├── lib/recurrences.js   # Pure schedule math for Task 6.12 (nextRunDate, dueRecurrences, manualMerchantKey) — DB-free, unit-tested
│   ├── lib/runRecurrences.js # Task 6.12 nightly executor — claims due recurrences, inserts their transaction, advances next_run_at
│   ├── lib/parser.js        # Anthropic-backed natural-language transaction parser (powers /api/transactions/parse)
│   ├── lib/askContext.js    # Pure context-bundle builder + DB loader for Ask Trim
│   ├── lib/askPrompt.js     # Ask Trim system-prompt builder (one-shot/cold-open variants, cache_control)
│   ├── lib/categoryKeywords.js # Keyword map + matcher for GET /api/categories/suggest (Task 6.9)
│   ├── lib/special.js       # Pure excludeSpecial/sumSpecial — the one place special expenses leave budget math (9.2)
│   ├── lib/overallBudget.js # Pure resolveTotalBudget/buildPace — the ONE definition of "your total budget" (Phase 10 A5). Shared by projections, affordability and budgets so they can't disagree. Unit-tested.
│   ├── lib/emoji.js         # Pure isSingleEmoji — grapheme-based validation for category icons + goal emoji (Phase 10 A3). Mirror of client/src/lib/emoji.js.
│   ├── middleware/auth.js   # requireAuth — verifies Supabase JWT, sets req.user
│   ├── routes/              # me, categories, transactions, dashboard, budgets, analytics, goals, wins, subscriptions, projections, affordability, ask, cron
│   ├── scripts/askEval.js   # 20-question ship-gate eval (hybrid grading)
│   ├── scripts/devMock.js   # `npm run dev:mock` — full in-memory /api/* on :3001, no Supabase/Anthropic needed (UI dev + demos)
│   ├── migrations/          # 001_init.sql … 015 — run in order on a fresh project
│   └── .env                 # PORT, CLIENT_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, ANTHROPIC_API_KEY, CRON_SECRET
│
├── ARCHITECTURE.md          # this file
└── FEATURES.md              # product vision / gamification spec
```

## Security requirements (non-negotiable)

- **Supabase keys split by scope.** Service-role key + JWT secret live only on the server. Browser only gets the anon/public key, used exclusively by the Supabase Auth SDK to obtain a JWT.
- **The browser NEVER reads/writes application data from Supabase directly.** All data flows through the Express API, which attaches `user_id` from the verified JWT to every query.
- **RLS enabled on every table** (categories, transactions, budgets, savings_goals, savings_contributions, subscription_overrides, user_stats). Policies are `USING (auth.uid() = user_id)`. Service-role bypasses RLS but we still scope every query by `req.user.id` — defence in depth.
- **JWT verification** (`server/middleware/auth.js`) uses `jose` + Supabase JWKS (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`). Asserts issuer and audience. Sets `req.user = { id: payload.sub, email: payload.email }`. Generic 401 on any failure — never leak why.
- **Rate limiting.** Global: 100 req / 15 min. Auth endpoints (when added): 10 / 15 min. `/api/ask`: 20 / hour, keyed off `req.user.id` (chat turns hit Claude — dedicated cap on cost-based DoS). `standardHeaders: 'draft-7'`, `legacyHeaders: false`. `app.set('trust proxy', 1)` for Railway.
- **helmet** with strict CSP: `defaultSrc 'self'`, `connectSrc 'self' + CLIENT_URL + *.supabase.co`, `scriptSrc 'self'`, `styleSrc 'self' 'unsafe-inline'`, `imgSrc 'self' data: https:`. HSTS 1y with preload.
- **CORS** restricted to the exact `CLIENT_URL` (no trailing slash). Methods whitelisted.
- **JSON body limit** 100kb.
- **Input validation with Zod** on every mutating route; response is `{ error, details }` on 400.
- **No stack traces in error responses** — log route+message server-side, return generic message.
- **UUID param guard** (`/^[0-9a-f-]{36}$/i`) before any query that takes an id, to reject malformed IDs cheaply.

## Database schema

- **Enums:** `transaction_type` (income, expense), `budget_period` (monthly, weekly), `currency_code` (GBP, USD, AUD, VND).
- **user_stats** (one row per user; PK = user_id): current_streak, longest_streak, shields, xp_points, level, badges (jsonb[]), currency, simple_mode, monthly_limit (nullable; the single cap simple_mode tracks against), display_name, last_logged_date. Seeded by trigger on `auth.users` insert.
- **categories:** user_id, name, icon (emoji), color (hex), type. 12 defaults seeded by the same trigger (9 expense + 3 income).
- **transactions:** user_id, category_id, amount (numeric), type, description, date, is_recurring, recurrence_id (nullable FK to `recurrences`, `on delete set null` — deleting a schedule never deletes history), created_at.
- **recurrences** (Task 6.12a): user-marked recurring schedules. user_id, category_id, type (expense-only), amount, description, interval (`monthly`|`weekly`), next_run_at (date), last_run_at (date, nullable), cancelled_at (timestamptz, nullable — soft-cancel: stops future creations, keeps history), created_at. The nightly cron (`lib/runRecurrences.js`) fires rows where `next_run_at <= today AND cancelled_at IS NULL`, claims each via an optimistic `UPDATE ... WHERE next_run_at = <the value it read>` (0 rows matched = another run already claimed it), then inserts that occurrence's transaction with `is_recurring=true` + `recurrence_id`. Never calls `applyLogEvent` — cron-created transactions award no XP and don't extend the streak (same rule as bank sync).
- **budgets:** user_id, category_id, amount_limit, period. Unique `(user_id, category_id, period)`.
- **savings_goals:** user_id, name, emoji, target_amount, current_amount, target_date, created_at.
- **savings_contributions:** goal_id, user_id, amount, note, created_at.
- **subscription_overrides:** PK `(user_id, merchant_key)`, status (`active`|`cancelled`|`dismissed`), display_name (≤40 chars, used to label inferred synthetic-key rows), decided_at. Stores the user's audit decision; detection always re-runs from `transactions` and merges overrides on top.
- **special_groups:** Phase 10 B1. user_id, name (≤60), archived_at, created_at. `transactions.special_group_id` references it `on delete set null`. Only ever set on a special expense — both the create and update routes reject a group on a non-special row, and un-starring clears it.
- **ask_messages:** chat transcript for Ask Trim. Columns: id, user_id, role (`user`|`assistant`), content (≤8000 chars), created_at. Indexed on `(user_id, created_at desc)` for history pagination. Answer-only — the server never writes anything else from a chat turn.
- **RLS:** `auth.uid() = user_id` on every table (including `recurrences`). `savings_contributions` uses the parent goal's user_id.
- **Data API grants:** app tables grant access to `service_role` so the Express server can query through Supabase's REST/Data API. Direct `anon`/`authenticated` table grants are intentionally omitted; the browser only uses Supabase Auth.
- **Trigger `handle_new_user`** on `auth.users` insert: creates `user_stats` row + seeds 12 default categories.

## API surface

All routes require a valid Supabase JWT except `/api/health`. Express router naming:

- `GET  /api/health` — uptime check.
- `GET  /api/me` — profile + stats + preferences.
- `PATCH /api/me` — update currency / simple_mode / display_name / monthly_limit (the simple-mode cap, nullable).
- `GET  /api/categories` — list (user-scoped).
- `GET  /api/categories/suggest?desc=…` — Task 6.9 merchant memory. Returns `{ categoryId, confidence ('high'|'medium'|'none'), source ('history'|'keyword'|'none') }`. History first (top category among the user's transactions whose description matches the first two words, case-insensitive), falling back to the hand-curated word-boundary keyword map in `server/lib/categoryKeywords.js` (matched against seeded default category names; skipped if renamed/deleted). Highlight-only on the client — never auto-selects.
- `POST /api/categories` — create custom category (Zod-validated).
- `PATCH /api/categories/:id` — rename / change icon / change colour (type and is_default are immutable).
- `DELETE /api/categories/:id` — delete; supports `?reassign_to=<otherId>` to bulk-move transactions before delete. Returns 409 with `{ transactionCount }` if transactions exist and no `reassign_to` is provided. Refuses to delete the seeded "Other" / "Other Income" categories (the reassign safety net) with 403. Cascades the budget on the deleted category.
- `GET  /api/transactions?limit=…` — list (max 200). Each row includes `is_recurring` + `recurrence_id` (Task 6.12a) so the client can badge cron-created (or originally opted-in) instances.
- `POST /api/transactions` — create; also runs `applyLogEvent` and returns `{ transaction, delta, recurrence }` so the UI can celebrate level-ups / streak milestones / shield earns. `recurrence` is `null` unless the request included an optional `recurring: { interval: 'monthly'|'weekly' }` (Task 6.12a, expense-only — 400 if `type: 'income'`): when present, the server creates a paired `recurrences` row first (so it has the id), inserts the transaction with `is_recurring=true` + `recurrence_id`, then returns both. If the transaction insert fails after the recurrence was created, the recurrence is best-effort deleted so no phantom subscription appears. The user's own opt-in transaction still awards XP/streak — only cron-created children skip that (Alex's decision, 2026-07-18).
- `POST /api/transactions/parse` — natural-language parser for QuickAdd. Body `{ text }` (≤500 chars). Calls Anthropic Messages (claude-haiku-4-5, max_tokens 200) with the user's category list + currency + today's date inlined into a JSON-only system prompt. Returns `{ parsed: { amount (minor units), currency, categoryId|null, description, occurredAt, confidence } }`. **Never writes** — the client uses the result to pre-fill QuickAdd, and the user still taps a chip to log. Low-confidence parses force `categoryId: null`. 503 when `ANTHROPIC_API_KEY` is unset; 422 on API/parse failure (client falls back to the structured form). Validates the model's JSON with Zod and drops any `categoryId` not owned by the user.
- `PATCH /api/transactions/:id` — inline edit.
- `DELETE /api/transactions/:id`.
- `GET  /api/dashboard` — aggregated widget payload (month totals, category breakdown, budget alerts ≥75%, recent 5, stats).
- `GET  /api/budgets` — list + this-month spend per category, plus `overall: { limit, spent, percent }` (Phase 10 A5). `overall.limit` is `user_stats.monthly_limit` (null when unset) and `overall.spent` is the whole month's countable expense spend across **every** category, not a per-category slice. Additive — the `budgets[]` shape is unchanged.
- `POST /api/budgets` — create (expense categories only, unique per category+period).
- `PATCH /api/budgets/:id` — update amount/period.
- `DELETE /api/budgets/:id`.
- `GET  /api/analytics?months=6` — { series[ym, label, income, expenses, net], topCategories[], mom }.
- `GET  /api/goals` — list with percent/completed flags.
- `POST /api/goals` — create.
- `PATCH /api/goals/:id` — update.
- `DELETE /api/goals/:id`.
- `POST /api/goals/:id/contributions` — add money; returns `{ goal, milestone (0.25/0.5/0.75/1.0 or null), justCompleted }`.
- `GET  /api/wins` — derives at-most-10 recent positive events ({ type, title, body, at, icon }) from transactions vs budgets (rolling 7d), `user_stats` streak/shields, and savings contributions. No new tables.
- `GET  /api/subscriptions` — runs `detectSubscriptions` on the user's expense transactions (excluding any that carry a `recurrence_id`, so a manually-marked charge is never also counted as a detected one — Task 6.12a), merges `subscription_overrides`, then appends one row per `recurrences` entry (active and cancelled) with `source: 'manual'` and key `manual:<uuid>`. Detected rows get `source: 'auto'`. Both share the same field shape (merchantKey, name, inferred, cadence, cadenceDays, amount, monthlyCost, annualCost, lastCharged, nextExpected, totalPaid, occurrences, categoryId, category, status, displayName, decidedAt) so the client never special-cases fields. Returns `{ subscriptions[], summary }`. Default detector rule: ≥3 same-merchant charges at ~30d or ~365d intervals (±5d) with amounts within 10%.
- `PATCH /api/subscriptions/:merchantKey` — dispatches on the `manual:` prefix (Task 6.12a). Manual keys toggle `recurrences.cancelled_at` (`{ status: 'active'|'cancelled' }`) and/or edit `{ amount }` (future instances only — past transactions already have their amount baked in and are never rewritten); `{ status: 'dismissed' }` is rejected with 400 (the user opted in deliberately — cancel is the off-ramp, not dismiss). Non-manual keys keep the existing behaviour exactly: upsert into `subscription_overrides` to mark a detected subscription `active`, `cancelled`, or `dismissed` (false positive — only meaningful on inferred/synthetic-key rows; excluded from the saved-money totals). Also accepts `displayName` to name an inferred row. Decisions survive re-detection.
- `GET  /api/projections/month` — linear-extrapolation forecast for current-month expenses. Returns `{ ready, projectedSpend, monthlyBudget, delta, spendSoFar, daysElapsed, daysInMonth, paceLabel, pace }`. `ready: false` when day-of-month < 3 or zero transactions logged this month (cold-start guard) — but `pace` is returned in **both** branches, so the pace line shows from day 1. **Outlier guard:** when a single transaction is >40% of spend-so-far (rent on the 1st), it's counted once and the run-rate is projected from everything else — otherwise day-4 projections explode. `paceLabel` compares projectedSpend against last month's total. `pace` is `{ target, spent, delta, budget, daysRemaining, perDayLeft, overBy }` or null when there's no budget at all; `perDayLeft` is floored at 0 and `overBy` carries the overage instead (Phase 10 A4). `monthlyBudget` and `pace` both come from `lib/overallBudget.js`, so the target and the spend it's compared against are always on the same basis — before Phase 10 they weren't, and partial budgeting read as permanently ahead of pace.
- `POST /api/affordability` — pure read+compute, no DB writes. Body `{ amount, categoryId? }`. Returns `{ categoryRemaining, totalRemaining, totalSource, goalImpactDays, goal, verdict }`. `categoryRemaining` is null when no category is given or the picked category has no monthly budget; `totalRemaining` is null when the user has neither an overall budget nor any monthly category budgets. `totalSource` is `'overall' | 'categories' | 'none'` and only exists so the client can say "left in your monthly budget" vs "left across all budgets" — two genuinely different claims. Uses the same `lib/overallBudget.js` resolver as projections. `goal` (and `goalImpactDays`) reference the soonest-target_date open savings goal, falling back to the earliest-created open goal; both are null when there are no open goals or no contributions in the last 90 days. Verdict is one of `'Comfortably yes' | 'Tight but yes' | 'Would push you over'` — never red language.
- `GET  /api/special-groups` — Phase 10 B1. Returns `{ groups: [{ id, name, archivedAt, total, count, firstDate, lastDate }] }`. `total` is **lifetime**, not this-month, and counts only `is_special` expenses — so un-starring a transaction immediately drops it out rather than leaving a stale number.
- `POST /api/special-groups` `{ name }` (1–60 chars) · `PATCH /:id` `{ name?, archived? }` · `DELETE /:id` — delete removes the GROUP only; `transactions.special_group_id` is `on delete set null`, so the spending survives, ungrouped.
- `POST /api/ask` — Ask Trim chat (Task 6.10). Body `{ message }` (≤2000 chars). Persists the user message, loads the last 90 days of transactions / current budgets / goals / contributions / stats via `loadAskContext`, builds a two-part system prompt (rules block `cache_control: ephemeral` + JSON user data) via `buildAskSystem`, and streams `claude-haiku-4-5` (max_tokens 1500; override with `ASK_MODEL` env var) back to the client over **SSE** with events `user_message` (canonical row for the just-inserted user message), `delta` (text chunk), `done` (final assistant row + token usage), and `error`. Includes the latest 10 prior messages as conversation context. Persists the final assistant text. Answer-only — the route never writes to any table except `ask_messages`. 503 when `ANTHROPIC_API_KEY` is unset. Client-disconnect aborts hang off `res.on('close')`, **never** `req.on('close')` — on Node 16+ the request emits `close` as soon as its body is consumed, which would abort the Anthropic stream instantly (this was a real shipped bug, fixed 2026-07).
- `GET  /api/ask/history` — most-recent 50 chat messages for the user, oldest-first.
- `DELETE /api/ask/history` — wipes the user's chat history.
- `POST /api/cron/recurrences` (also `GET`, since Vercel Cron issues GET) — Task 6.12a nightly executor. **Not behind `requireAuth`** (no user JWT exists — it's machine-invoked) and **not scoped by `req.user.id`** — a deliberate, documented exception, since a nightly batch job has no single user to scope to by design. Guarded instead by `Authorization: Bearer ${CRON_SECRET}` compared with `crypto.timingSafeEqual`. Unset `CRON_SECRET` → 503 (fails closed, never open); mismatch → generic 401. Runs `lib/runRecurrences.js` and returns `{ created, skipped, errors }`. See SECURITY.md for the full contract.

## Client data-flow rules

- **One auth source of truth:** `useAuth` hook wraps the Supabase client. Exposes `{ session, user, isLoading, signIn, signUp, signOut }`.
- **One API binding:** `useApi` returns `{ get, post, patch, del }` bound to the current `session.access_token`. Re-memoised on token change so TanStack Query refreshes.
- **Query keys stay stable:** `['me']`, `['dashboard']`, `['transactions']`, `['categories']`, `['budgets']`, `['goals']`, `['analytics', 6]`, `['wins']`, `['subscriptions']`, `['projections', 'month']`, `['ask', 'history']`. Mutations invalidate their downstream queries.
- **Theme:** HTML gets `class="dark"` by default; toggle persists to `localStorage['trim-theme']`. An inline script in `index.html` applies the stored value before React mounts (no flash).
- **Currency display:** read from `/api/me` preferences; never hardcode.
- **Visual system:** design tokens live in `client/src/index.css` (`:root` + `.dark`). Custom utilities (`.mesh-bg`, `.glass`, `.lift`, `.shimmer-bar`, `.sheen-mask`, `.text-gradient`, `.nums`, `.gradient-border`) and a small motion vocabulary (`animate-flame`, `animate-blob`, `animate-float-slow`, `animate-ring-pulse`, `animate-fade-up`, `animate-pop-in`, `animate-shimmer`) are declared in `tailwind.config.js`. All animations honour `prefers-reduced-motion`. See FEATURES.md → Design direction → Visual language for usage rules.

## Deployment notes

- **Railway** sits behind a proxy — `app.set('trust proxy', 1)` is required for `express-rate-limit` to key off the real client IP.
- **Build commands:** client `vite build` → static; server `node index.js`.
- **Env:** CLIENT_URL must exactly match the deployed client origin (no trailing slash) for CORS + CSP `connectSrc`.
- **Recurrences cron (Task 6.12a):** Vercel Cron, `0 3 * * *` (03:00 UTC daily), configured in `server/vercel.json` (`crons: [{ path: '/api/cron/recurrences', schedule: '0 3 * * *' }]`) — Hobby plan allows 2 cron jobs at once-daily each, this uses one. Requires `CRON_SECRET` set in the Vercel project's env (see SECURITY.md). Note: this project's hosting notes above still describe Railway; per the 6.12a brief, Trim moved to Vercel 2026-07-13 and Railway cron no longer exists — the Railway-specific bullets in this section may be stale and worth reconciling in a future session.
