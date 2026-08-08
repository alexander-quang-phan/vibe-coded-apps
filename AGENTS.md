# AGENTS.md — Trim (budget tracking app)

Full-stack personal budgeting app ("Trim your spending. Grow your savings."). Alex uses it daily
and plans to share it with friends. **React + Vite client, Express server, Supabase (Auth +
Postgres), hosted on Vercel** (moved off Railway on 2026-07-13; live at
https://trim-budget.vercel.app).

This project is worked by **both Codex and Claude Code** using the dual-agent workflow (full
protocol in your global `~/.codex/AGENTS.md`).

## Every session, first
1. Read the source-of-truth docs: **TRIM.md** (stack/architecture/deploy), **ARCHITECTURE.md**,
   **FEATURES.md**, **SECURITY.md**, **BUILD_PLAN.md** (phased plan + progress).
2. Read **CHAT_HANDOFF.md** — current state and the `## DUAL-AGENT BATON` block at the top. Do
   only the stage the baton says is yours; the OTHER model validates before moving on.
3. Update the baton the moment you finish, and tell Alex which model to run next.

## How to run it
- Client build (the first gate of "done"): `cd client && npm run build`.
- Server tests (e.g. crypto): `cd server && npm test`.
- Local mock API: `cd server && npm run dev:mock`.
- Deploy is Vercel, from `main` — leave deploys to Alex / the `deploy` workflow; don't improvise them.

## Rules a model must never break
- **The client NEVER talks to Supabase for data — all data goes through the Express API.** This is
  the core architecture rule (ARCHITECTURE.md). Don't change the architecture without asking Alex.
- **Definition of done, every feature:** `npm run build` passes in `client/`; **the feature is
  actually reachable in the running UI** (the #1 past failure — features declared done while
  invisible); BUILD_PLAN.md + FEATURES.md updated same session (SECURITY.md too if auth/data
  changed); work committed. In a worktree, say explicitly it still needs merging to `main` —
  nothing deploys until it's on `main`.
- **Never enter passwords or get past Supabase login.** The app sits behind auth, so live
  click-through testing is Alex's job only. Verify at the API / bundle level, never by logging in.
- **Never generate or handle `DATA_ENCRYPTION_KEY`** (the at-rest encryption key). Losing it makes
  every user's financial data unrecoverable — only Alex generates, stores, and backs it up.
- Secrets live in `.env` files (gitignored). Never hardcode or commit keys.
- Alex is a beginner/intermediate programmer — explain what you did in plain language, and give
  exact step-by-step instructions for anything manual (SQL, env vars, dashboard clicks).

## Dual-agent note
Trim is actively developed, so most days are ordinary single-model feature work. Reserve the full
two-model loop for **big or risky changes** — the standout is **Phase 9.5 (encryption at rest)**,
which is half-built and inert: a "most capable model" review already found three Critical defects
there, two from the plan's own example code. That is exactly the kind of change where the OTHER
model must verify before anything ships.
