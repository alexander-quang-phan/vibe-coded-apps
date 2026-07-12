---
name: deploy
description: Ship Trim to production (Vercel) safely — merge, build-check, push, deploy, verify. Use whenever Alex says deploy, ship, push live, "make it live", "merge and deploy", asks "is it deployed?", or finishes a feature he wants to use in the real app.
---

# Deploy Trim

Hosting (since 2026-07-13): **Vercel free tier**, two projects on Alex's account — `trim-budget` (client, https://trim-budget.vercel.app) and `trim-api` (server, https://trim-api-jade.vercel.app). Deploys happen from `main` via the authenticated Vercel CLI — **pushing to GitHub does NOT auto-deploy** (no git integration connected). See DEPLOY.md for env vars and the Railway alternative.

## Step 0 — confirm the target
Alex has previously said "deploy" when he meant "run it locally so I can look at it" (May 2026 sessions). If there's any chance that's the case — early-stage feature, no explicit mention of "live"/"production"/"push" — ask one question first: **"Live site, or just running locally?"** A wrong local run costs a minute; a wrong production push is public.

## Steps

1. **Get the work onto main.**
   - If on a feature/worktree branch: confirm the working tree is committed, then merge into `main`. List any other unmerged `claude/*` branches and tell Alex what's in them (`git branch --no-merged main`), so finished features don't sit forgotten in worktrees.
   - If already on `main`: commit pending changes with a clear message.
2. **Build check before deploying.** Run `npm run build` in `client/`. A broken build deployed means a broken live site.
3. **Push, then deploy.** `git push origin main`, then from the main checkout: `cd client && vercel deploy --prod --yes` — and `cd server && vercel deploy --prod --yes` only if server code changed (client-only UI changes don't need it).
4. **Verify live.** After a couple of minutes, load the live client URL and hit the API health/login flow. Report what you actually observed, not what should have happened.
5. **Report.** Tell Alex in plain terms: what got deployed (features/commits), the live URL, and anything he should click through to double-check.

## Safety rails
- Never commit or push `.env` files or keys. If a secret ever ends up in a commit, stop and flag it before pushing.
- If `main` has half-finished work that shouldn't go live, say so and let Alex decide — don't push blind.
