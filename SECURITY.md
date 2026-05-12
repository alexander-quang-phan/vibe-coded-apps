# Trim — Security Contract

> Captured from the original build prompt. These are non-negotiable defaults. Any future change that touches auth, data access, or deployment **must** be checked against this list before shipping.

## Threat model

Single-tenant-per-user SaaS. Every row in every table is owned by exactly one `user_id`. The attacker we care about most is another logged-in user trying to read someone else's data. Secondary concerns: credential stuffing on `/auth`, XSS via user-entered notes/names, denial-of-service via unbounded inputs.

## Key separation (the most important rule)

| Key | Where it lives | What it does |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only** (`server/.env`) | Bypasses RLS. Used for every data query from Express. |
| `SUPABASE_URL` | **Server only** (`server/.env`) | Used as the JWKS fetch origin for verifying user tokens. |
| `SUPABASE_JWT_SECRET` | Unused today (kept for rollback) | Only needed if the project is flipped back to legacy HS256 signing. |
| `ANTHROPIC_API_KEY` | **Server only** (`server/.env`) | Powers `POST /api/transactions/parse` (natural-language QuickAdd) and `POST /api/ask` (Ask Trim chat). Never exposed to the browser — the client posts plain text and receives either a sanitised draft (parse) or a streamed answer (ask). |
| `VITE_SUPABASE_ANON_KEY` | Browser (`client/.env`) | Public. Used **only** by the Supabase Auth SDK (signup / login / refresh). |
| `VITE_SUPABASE_URL` | Browser (`client/.env`) | Public. Auth SDK target. |

**Rule:** the browser must never read or write application data from Supabase directly. Every data access flows through our Express API, which attaches `user_id` from the verified JWT.

## RLS (defence in depth)

- Every user-data table (`user_stats`, `categories`, `transactions`, `budgets`, `savings_goals`, `savings_contributions`, `subscription_overrides`) has `ENABLE ROW LEVEL SECURITY`.
- Policies are `USING (auth.uid() = user_id)` and `WITH CHECK (auth.uid() = user_id)`.
- `savings_contributions` derives `user_id` from the parent goal's `user_id`.
- Supabase's Data API also requires Postgres object grants. App tables grant privileges to `service_role` only; `anon` and `authenticated` are not granted direct table access because the browser must go through Express.
- Even though the service-role key bypasses RLS, every server query still filters by `.eq('user_id', req.user.id)` — belt and braces. If the middleware ever mis-sets `req.user.id`, RLS still won't match because the query is scoped.

## Auth middleware

`server/middleware/auth.js` must:

- Read `Authorization: Bearer <jwt>`.
- Verify using `jose` with Supabase's JWKS endpoint (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`) — this supports the project's asymmetric signing keys (ES256 today; future-proof for key rotation). `jose` caches keys and picks the right one by `kid`.
- Assert `issuer` = `{SUPABASE_URL}/auth/v1` and `audience` = `authenticated`.
- On any failure (missing header, malformed token, expired, bad signature, wrong issuer/audience) return **401 with a generic message**. Never leak why. Never log the token.
- On success set `req.user = { id: payload.sub, email: payload.email }` and call `next()`.

No route is exposed without `requireAuth` except `/api/health`.

**If the Supabase project is flipped back to legacy HMAC (HS256):** swap `jose` for `jsonwebtoken`, verify with `SUPABASE_JWT_SECRET` and `algorithms: ['HS256']`. The rest of the middleware stays the same.

## Input validation

- **Every mutating route validates its body with Zod.** On failure: `400 { error: 'Invalid X', details: parsed.error.flatten() }`.
- Amount fields: `.positive().finite().max(1_000_000_000)`.
- Date fields: ISO `YYYY-MM-DD` regex.
- String fields have `.trim().max(N)` to kill giant payloads and trailing whitespace.
- UUID route params validated with `/^[0-9a-f-]{36}$/i` **before** any DB call.
- `express.json({ limit: '100kb' })` to reject oversize JSON at the parser.

## Rate limiting

- Global: 100 req / 15 min (`globalLimiter`), mounted before any route.
- Auth-sensitive routes (when we add our own `/api/auth/*` wrappers): 10 / 15 min (`authLimiter`, exported).
- `/api/ask`: 20 / hour (`askLimiter`), keyed off `req.user.id`. Every chat turn invokes Claude Sonnet 4.6 with up to 1500 output tokens — the dedicated limit caps both runaway-client and cost-based-DoS scenarios. Mounted *after* `requireAuth` so the per-user key resolves.
- `standardHeaders: 'draft-7'`, `legacyHeaders: false`, friendly JSON `message`.
- **`app.set('trust proxy', 1)`** is required on Railway, otherwise `express-rate-limit` keys off the proxy IP.

## HTTP hardening (helmet)

```js
helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", CLIENT_URL, 'https://*.supabase.co'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
})
```

- `'unsafe-inline'` is allowed in `styleSrc` for Tailwind's inline style output only; **never** add it to `scriptSrc`.
- `connectSrc` includes `*.supabase.co` for the Auth SDK's websocket + REST endpoints.

## CORS

- Origin is the **exact** `CLIENT_URL` string, no trailing slash.
- Methods whitelisted: `GET, POST, PATCH, PUT, DELETE, OPTIONS`.
- `credentials: true` (in case cookies are added later).
- CORS is set **after** helmet so preflight responses still carry hardening headers.

## Error handling

- Global error handler logs `{ route: req.originalUrl, message: err.message }`.
- Response body: `{ error: err.publicMessage || 'Internal server error' }` — no stack, no SQL, no user-controlled input echoed back.
- 404 handler returns a generic `{ error: 'Not found' }`.

## Secrets management

- `.env.example` files are committed; real `.env` files are **never** committed.
- The server fails fast if `CLIENT_URL` is missing. Add similar fatal checks for any new required env var.
- Service-role key is **never** logged, printed, or returned to the client.

## XSS & injection

- React escapes by default — no `dangerouslySetInnerHTML` anywhere in the client.
- User-entered strings (transaction notes, category names, goal names) are stored as-is and rendered as text nodes. No templating that interpolates HTML.
- All DB access is via parameterised queries through `@supabase/supabase-js` — no raw SQL concatenation.

## Auth UX rules

- Login error messages are generic ("Email or password is incorrect") — don't confirm whether an email exists.
- Signup rejects passwords under 8 chars client-side; the server still validates separately.
- Supabase Auth handles password hashing; we never touch raw passwords server-side.
- Tokens are stored by the Supabase SDK (localStorage by default). No custom token storage.

## Deployment checklist (before any deploy)

- [ ] `CLIENT_URL` matches the exact deployed client origin (no trailing slash, correct protocol).
- [ ] All three Supabase env vars set on the server. Anon key + URL set on the client build.
- [ ] `server/migrations/002_service_role_grants.sql` has been run if the initial migration was applied before service-role grants were added.
- [ ] `app.set('trust proxy', 1)` active (it is — don't remove).
- [ ] RLS enabled on every user-data table (run `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'` and confirm).
- [ ] `001_init.sql` trigger `handle_new_user` is present (creates `user_stats` + 12 defaults on signup).
- [ ] Email confirmation: set per team preference (dev: off; prod: on).
- [ ] Service-role key rotated if it ever appeared in logs or commits.

## When in doubt

- **Scope every server query by `req.user.id` even if RLS would also enforce it.**
- **Reject malformed IDs cheaply** (UUID regex) before hitting the DB.
- **Never return raw Supabase error messages** to the client — wrap or replace.
- **Never add a route without `requireAuth`** unless it's a health check.
