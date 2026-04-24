# Trim

> Trim your spending. Grow your savings.

Full-stack budget tracking web app.

## Stack

- **Frontend:** React 18 + Vite + React Router v6 + Tailwind CSS + shadcn/ui + TanStack Query + React Hook Form + Zod
- **Backend:** Node.js + Express + Helmet + Zod + express-rate-limit
- **Database & Auth:** Supabase (PostgreSQL + Row Level Security + Supabase Auth)
- **Hosting:** Railway (frontend: static site, backend: Express service)

## Architecture

```
┌────────────┐      HTTP      ┌────────────┐   service-role   ┌────────────┐
│   React    │ ─────────────▶ │  Express   │ ───────────────▶ │  Supabase  │
│  (client)  │ ◀──── JWT ───── │  (server)  │ ◀── verify JWT ── │ (Auth+DB) │
└────────────┘                └────────────┘                  └────────────┘
```

**The client never talks to Supabase for data.** It uses the Supabase Auth client SDK
(with the public `anon` key) only to sign up / log in, which returns a JWT. That JWT
is sent to our Express API on every request. The server verifies the JWT, attaches
`req.user`, and performs all data access with the `service_role` key — scoping every
query to `req.user.id`. Row Level Security remains enabled as defence-in-depth.

## Project structure

```
/
├── client/              React + Vite frontend
│   ├── src/
│   │   ├── components/  Shared components (ui/ = shadcn)
│   │   ├── pages/       Route-level pages
│   │   ├── hooks/       Custom React hooks
│   │   ├── lib/         api client, utils
│   │   └── main.jsx     Entry + router
│   └── vite.config.js
├── server/              Express API
│   ├── routes/          Route handlers
│   ├── middleware/      auth.js (JWT verify)
│   ├── lib/             supabase.js (service-role client)
│   └── index.js
└── README.md
```

## Setup

### 1. Prerequisites

- Node.js 20+
- npm 10+
- A Supabase project (free tier works)

### 2. Install dependencies

```bash
cd server && npm install && cd ..
cd client && npm install && cd ..
```

### 3. Configure environment

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Then fill in the values (see below).

### 4. Supabase values

In the Supabase dashboard (Project settings → API):

| Variable                     | Where                                       | Who sees it       |
|------------------------------|---------------------------------------------|-------------------|
| `SUPABASE_URL`               | Project URL                                 | server + client   |
| `SUPABASE_SERVICE_ROLE_KEY`  | Project API keys → `service_role`           | **server only**   |
| `SUPABASE_JWT_SECRET`        | JWT Settings → JWT Secret                   | **server only**   |
| `SUPABASE_ANON_KEY`          | Project API keys → `anon public`            | server + client   |

Database tables (`categories`, `transactions`, `budgets`, `user_stats`) and RLS
policies will be set up in a follow-up task.

### 5. Run locally

```bash
# Terminal 1 — backend on :3001
cd server && npm run dev

# Terminal 2 — frontend on :5173
cd client && npm run dev
```

Open http://localhost:5173.

The Vite dev server proxies `/api/*` → `http://localhost:3001`, so the client
can call `fetch('/api/health')` in development without CORS concerns.

## Security guarantees

- All Supabase secret keys live in `server/.env`; client only holds the anon key.
- `helmet()` enabled with CSP, HSTS.
- CORS restricted to `CLIENT_URL`.
- Global rate limit: 100 req / 15 min / IP. Auth routes: 10 req / 15 min / IP.
- Zod validates every request body at the route boundary.
- Every protected route goes through `middleware/auth.js`, which verifies the
  Supabase-issued JWT (HS256 + `SUPABASE_JWT_SECRET`) and sets `req.user`.
- Logs never include tokens, emails, or request bodies — only user IDs and route names.

## Deployment (Railway)

Create two Railway services from this repo:

1. **server**
   - Root directory: `server/`
   - Start command: `npm start`
   - Env vars: `PORT`, `CLIENT_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`

2. **client**
   - Root directory: `client/`
   - Build command: `npm run build`
   - Serve `dist/` as static site
   - Env vars: `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

After deploying, set `CLIENT_URL` on the server service to the client's deployed
origin (no trailing slash).
