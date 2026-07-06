# Trim — Budget Tracking App

Full-stack personal budgeting app ("Trim your spending. Grow your savings."). Alex uses it daily and plans to share it with friends. React + Vite client, Express server, Supabase (Auth + Postgres), hosted on Railway.

## Source of truth — read before coding
- **TRIM.md** — stack, architecture diagram, project structure, deployment setup
- **ARCHITECTURE.md** — how client/server/Supabase fit together. The client NEVER talks to Supabase for data; all data goes through the Express API.
- **FEATURES.md** — what exists and how each feature should behave
- **SECURITY.md** — auth/JWT/RLS rules. Never weaken these.
- **BUILD_PLAN.md** — the phased plan and current progress

## Working rules
- One task per session. Do the task, verify it, stop. Don't change the architecture without asking.
- Alex is a beginner/intermediate programmer. Explain what you did in plain language, and when he needs to do something manually (run SQL, set env vars, click through a dashboard), give exact step-by-step instructions.
- Secrets live in `.env` files (gitignored). Never hardcode or commit keys.

## Definition of done — every feature, no exceptions
1. `npm run build` passes in `client/` (and the server starts cleanly if you touched it).
2. **The feature is actually reachable in the running UI.** Start the dev server and click to it. Features have been declared "done" here before while being invisible in the app — this is the #1 failure mode to avoid.
3. BUILD_PLAN.md and FEATURES.md are updated in the same session (SECURITY.md too if auth or data access changed).
4. Work is committed. If you're in a worktree, say explicitly that it still needs merging to `main` — nothing deploys until it's on `main`.

When finishing, tell Alex exactly where to find the new feature in the UI (which page, which button).

## Deploying
Railway hosts two services (client static site + server). Deploys happen from `main`. Use the `/deploy` skill rather than improvising steps.
