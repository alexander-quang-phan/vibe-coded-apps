# Deploying Trim

Two services on Railway (API + static client) talking to your existing Supabase
project. Follow top to bottom; every step is copy-paste-able. Nothing here
requires touching code.

```
Browser ──▶ client (Railway static)          Supabase (Auth + Postgres)
   │            │                                    ▲
   └── auth ────┼──── JWT ──▶ server (Railway) ──────┘
                └──────────── /api/* ▲
```

## 0. What you need

- The GitHub repo for this project (push it first if it only lives locally).
- Your Supabase project (`Trim_Budgeting_App`, ref `fqfzjcpypxvikdgmegzq`) — already
  set up with migrations 001–009 applied.
- A [Railway](https://railway.com) account (Hobby plan, ~$5/mo, includes both services).
- Your Anthropic API key (powers Ask Trim + the AI quick-add parser).

## 1. Supabase — one-time checks

The database already exists. Before going live:

1. **Keep it awake.** Free-tier Supabase projects pause after ~1 week without
   traffic (this already bit us once — the DNS literally disappears). Either
   upgrade the project to Pro ($10/mo), or accept that you must "Restore" it
   from the dashboard whenever it pauses.
2. **Auth settings** (Dashboard → Authentication):
   - *Sign In / Providers → Email*: leave email+password enabled.
   - *Rate limits*: defaults are fine.
   - *Passwords*: enable **leaked password protection** (flagged by the
     security advisor; one toggle).
   - *URL Configuration → Site URL*: set to your deployed client URL once you
     know it (step 3), e.g. `https://trim-client-production.up.railway.app`.
3. **Migrations on a fresh project** (only if you ever rebuild from zero): run
   `server/migrations/001…009_*.sql` in order in the SQL Editor.
4. Collect the four values you'll need (Dashboard → Project Settings → API):
   - Project URL → `SUPABASE_URL` / `VITE_SUPABASE_URL`
   - `anon` / publishable key → `VITE_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server only, never the client)
   - Settings → API → JWT Secret → `SUPABASE_JWT_SECRET` (server only)

## 2. Railway — API service

1. Railway dashboard → **New Project → Deploy from GitHub repo** → pick this repo.
2. In the new service's **Settings**:
   - **Root Directory**: `server`
   - Build/start are picked up from `server/railway.json` (start `npm start`,
     health check `/api/health`). No changes needed.
3. **Variables** tab — add:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `CLIENT_URL` | placeholder for now — you'll paste the real client URL in step 4 |
   | `SUPABASE_URL` | `https://fqfzjcpypxvikdgmegzq.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 1.4 |
   | `SUPABASE_JWT_SECRET` | from step 1.4 |
   | `ANTHROPIC_API_KEY` | your key — **server service only** |

   (Don't set `PORT` — Railway injects it.)
4. **Settings → Networking → Generate Domain**. Note the URL, e.g.
   `https://trim-api-production.up.railway.app`.
5. Check it's alive: open `<api-url>/api/health` → `{"status":"ok",...}`.

## 3. Railway — client service

1. Same Railway project → **+ New → GitHub Repo** → same repo again.
2. Service **Settings**:
   - **Root Directory**: `client`
   - Build/start come from `client/railway.json` (build `npm run build`,
     start `serve -s dist`).
3. **Variables** tab — add (these are baked in at build time):

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | the API URL from step 2.4, **no trailing slash** |
   | `VITE_SUPABASE_URL` | `https://fqfzjcpypxvikdgmegzq.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | the anon/publishable key |

4. **Settings → Networking → Generate Domain**. This is your app's address —
   the one you share with friends and family.

## 4. Point them at each other

1. Back on the **API service → Variables**: set `CLIENT_URL` to the client's
   domain from step 3.4 — exact origin, `https://`, **no trailing slash**.
   (CORS and the CSP `connect-src` both key off this; a mismatch = blank
   dashboard with console errors.)
2. Supabase → Authentication → URL Configuration → **Site URL** = same client URL.
3. Redeploy both services (Railway → service → Deployments → ⋮ → Redeploy) so
   env changes take effect. The client must rebuild for `VITE_*` changes.

## 5. Smoke test (2 minutes)

1. Open the client URL on your phone and your laptop.
2. Sign up with a real email → you land on the Dashboard with 12 seeded
   categories and a friendly empty state.
3. Log a transaction with the **+** button (3 taps) → "+10 XP" toast.
4. Open **Ask Trim** (sparkle button, bottom-left) → ask "what did I spend this
   week?" → streamed answer.
5. Settings → toggle Simple mode on/off; set a monthly limit.

If anything fails, check the API service logs first (Railway → service → Logs):
CORS errors mean `CLIENT_URL` doesn't match; 401s mean a wrong
`SUPABASE_JWT_SECRET`.

## 6. Costs

| Thing | Cost |
|---|---|
| Railway Hobby (both services) | ~$5/mo, includes usage credit |
| Supabase Free tier | $0, pauses when idle · Pro $10/mo never pauses |
| Anthropic API (Ask Trim + parser, Haiku 4.5) | pennies — a chat turn ≈ $0.002; rate-limited to 20/user/hour |

## 7. Sharing with friends & family (and beyond)

- Anyone with the URL can sign up — every user gets their own isolated data
  (RLS + per-user scoping on every query).
- Before sharing widely, consider in Supabase Auth: **enable email
  confirmation** (Authentication → Sign In / Providers → Email → Confirm email)
  so strangers can't squat on someone's address.
- If it takes off and you want to sell it: put the client behind a custom
  domain (Railway → client service → Settings → Custom Domain), upgrade
  Supabase to Pro, and revisit the `100 req / 15 min` global rate limit in
  `server/index.js` (it's per-IP; fine for dozens of users, tight for hundreds).

## Env var reference

| Variable | Where | Purpose |
|---|---|---|
| `PORT` | server (Railway injects) | HTTP port |
| `NODE_ENV` | server | `production` |
| `CLIENT_URL` | server | exact client origin for CORS/CSP |
| `SUPABASE_URL` | server + client (`VITE_`) | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | server **only** | data access (bypasses RLS) |
| `SUPABASE_JWT_SECRET` | server **only** | verify user JWTs |
| `ANTHROPIC_API_KEY` | server **only** | Ask Trim chat + NL quick-add parser |
| `ASK_MODEL` | server, optional | override Ask Trim model (default `claude-haiku-4-5`) |
| `VITE_API_URL` | client build | API base URL ('' in dev = Vite proxy) |
| `VITE_SUPABASE_ANON_KEY` | client build | Supabase Auth sign-in only |
