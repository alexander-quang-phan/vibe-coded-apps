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
│   │   ├── lib/             # api.js, format.js, confetti.js, utils.js, supabase client
│   │   ├── pages/           # Dashboard, Transactions, Budgets, Analytics, SavingsGoals, Subscriptions, Settings, Login, Signup
│   │   ├── App.jsx          # Auth-aware shell + nav + theme toggle
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
│   ├── lib/parser.js        # Anthropic-backed natural-language transaction parser (powers /api/transactions/parse)
│   ├── lib/askContext.js    # Pure context-bundle builder + DB loader for Ask Trim
│   ├── lib/askPrompt.js     # Ask Trim system-prompt builder (one-shot/cold-open variants, cache_control)
│   ├── middleware/auth.js   # requireAuth — verifies Supabase JWT, sets req.user
│   ├── routes/              # me, categories, transactions, dashboard, budgets, analytics, goals, wins, subscriptions, projections, affordability, ask
│   ├── scripts/askEval.js   # 20-question ship-gate eval (hybrid grading)
│   ├── migrations/001_init.sql  # Full schema + RLS + triggers
│   └── .env                 # PORT, CLIENT_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, ANTHROPIC_API_KEY
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
- **transactions:** user_id, category_id, amount (numeric), type, description, date, is_recurring, created_at.
- **budgets:** user_id, category_id, amount_limit, period. Unique `(user_id, category_id, period)`.
- **savings_goals:** user_id, name, emoji, target_amount, current_amount, target_date, created_at.
- **savings_contributions:** goal_id, user_id, amount, note, created_at.
- **subscription_overrides:** PK `(user_id, merchant_key)`, status (`active`|`cancelled`|`dismissed`), display_name (≤40 chars, used to label inferred synthetic-key rows), decided_at. Stores the user's audit decision; detection always re-runs from `transactions` and merges overrides on top.
- **ask_messages:** chat transcript for Ask Trim. Columns: id, user_id, role (`user`|`assistant`), content (≤8000 chars), created_at. Indexed on `(user_id, created_at desc)` for history pagination. Answer-only — the server never writes anything else from a chat turn.
- **RLS:** `auth.uid() = user_id` on every table. `savings_contributions` uses the parent goal's user_id.
- **Data API grants:** app tables grant access to `service_role` so the Express server can query through Supabase's REST/Data API. Direct `anon`/`authenticated` table grants are intentionally omitted; the browser only uses Supabase Auth.
- **Trigger `handle_new_user`** on `auth.users` insert: creates `user_stats` row + seeds 12 default categories.

## API surface

All routes require a valid Supabase JWT except `/api/health`. Express router naming:

- `GET  /api/health` — uptime check.
- `GET  /api/me` — profile + stats + preferences.
- `PATCH /api/me` — update currency / simple_mode / display_name / monthly_limit (the simple-mode cap, nullable).
- `GET  /api/categories` — list (user-scoped).
- `POST /api/categories` — create custom category (Zod-validated).
- `PATCH /api/categories/:id` — rename / change icon / change colour (type and is_default are immutable).
- `DELETE /api/categories/:id` — delete; supports `?reassign_to=<otherId>` to bulk-move transactions before delete. Returns 409 with `{ transactionCount }` if transactions exist and no `reassign_to` is provided. Refuses to delete the seeded "Other" / "Other Income" categories (the reassign safety net) with 403. Cascades the budget on the deleted category.
- `GET  /api/transactions?limit=…` — list (max 200).
- `POST /api/transactions` — create; also runs `applyLogEvent` and returns `{ transaction, delta }` so the UI can celebrate level-ups / streak milestones / shield earns.
- `POST /api/transactions/parse` — natural-language parser for QuickAdd. Body `{ text }` (≤500 chars). Calls Anthropic Messages (claude-haiku-4-5, max_tokens 200) with the user's category list + currency + today's date inlined into a JSON-only system prompt. Returns `{ parsed: { amount (minor units), currency, categoryId|null, description, occurredAt, confidence } }`. **Never writes** — the client uses the result to pre-fill QuickAdd, and the user still taps a chip to log. Low-confidence parses force `categoryId: null`. 503 when `ANTHROPIC_API_KEY` is unset; 422 on API/parse failure (client falls back to the structured form). Validates the model's JSON with Zod and drops any `categoryId` not owned by the user.
- `PATCH /api/transactions/:id` — inline edit.
- `DELETE /api/transactions/:id`.
- `GET  /api/dashboard` — aggregated widget payload (month totals, category breakdown, budget alerts ≥75%, recent 5, stats).
- `GET  /api/budgets` — list + this-month spend per category.
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
- `GET  /api/subscriptions` — runs `detectSubscriptions` on the user's expense transactions, merges `subscription_overrides`, returns `{ subscriptions[], summary }`. Default rule: ≥3 same-merchant charges at ~30d or ~365d intervals (±5d) with amounts within 10%.
- `PATCH /api/subscriptions/:merchantKey` — upsert into `subscription_overrides` to mark a detected subscription `active`, `cancelled`, or `dismissed` (false positive — only meaningful on inferred/synthetic-key rows; excluded from the saved-money totals). Also accepts `displayName` to name an inferred row. Decisions survive re-detection.
- `GET  /api/projections/month` — linear-extrapolation forecast for current-month expenses. Returns `{ ready, projectedSpend, monthlyBudget, delta, spendSoFar, daysElapsed, daysInMonth, paceLabel }`. `ready: false` when day-of-month < 3 or zero transactions logged this month (cold-start guard). `monthlyBudget`/`delta` are null when the user has no monthly budgets set.
- `POST /api/affordability` — pure read+compute, no DB writes. Body `{ amount, categoryId? }`. Returns `{ categoryRemaining, totalRemaining, goalImpactDays, goal, verdict }`. `categoryRemaining` is null when no category is given or the picked category has no monthly budget; `totalRemaining` is null when the user has no monthly budgets at all. `goal` (and `goalImpactDays`) reference the soonest-target_date open savings goal, falling back to the earliest-created open goal; both are null when there are no open goals or no contributions in the last 90 days. Verdict is one of `'Comfortably yes' | 'Tight but yes' | 'Would push you over'` — never red language.
- `POST /api/ask` — Ask Trim chat (Task 6.10). Body `{ message }` (≤2000 chars). Persists the user message, loads the last 90 days of transactions / current budgets / goals / contributions / stats via `loadAskContext`, builds a two-part system prompt (rules block `cache_control: ephemeral` + JSON user data) via `buildAskSystem`, and streams `claude-sonnet-4-6` (max_tokens 1500) back to the client over **SSE** with events `user_message` (canonical row for the just-inserted user message), `delta` (text chunk), `done` (final assistant row + token usage), and `error`. Includes the latest 10 prior messages as conversation context. Persists the final assistant text. Answer-only — the route never writes to any table except `ask_messages`. 503 when `ANTHROPIC_API_KEY` is unset.
- `GET  /api/ask/history` — most-recent 50 chat messages for the user, oldest-first.
- `DELETE /api/ask/history` — wipes the user's chat history.

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
