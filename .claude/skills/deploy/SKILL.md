---
name: deploy
description: Ship Trim to production (Railway) safely — merge, build-check, push, verify. Use whenever Alex says deploy, ship, push live, "make it live", "merge and deploy", asks "is it deployed?", or finishes a feature he wants to use in the real app.
---

# Deploy Trim

Hosting: Railway, two services built from this GitHub repo (`client/` static site, `server/` Express). Deploys happen from `main` — see TRIM.md "Deployment (Railway)" for service config and env vars.

## Steps

1. **Get the work onto main.**
   - If on a feature/worktree branch: confirm the working tree is committed, then merge into `main`. List any other unmerged `claude/*` branches and tell Alex what's in them (`git branch --no-merged main`), so finished features don't sit forgotten in worktrees.
   - If already on `main`: commit pending changes with a clear message.
2. **Build check before pushing.** Run `npm run build` in `client/`. A broken build pushed to Railway means a broken live site.
3. **Push.** `git push origin main`. Railway builds from GitHub automatically; if it doesn't pick up the push, tell Alex to check the Railway dashboard (or use `railway up` if the CLI is linked).
4. **Verify live.** After a couple of minutes, load the live client URL and hit the API health/login flow. Report what you actually observed, not what should have happened.
5. **Report.** Tell Alex in plain terms: what got deployed (features/commits), the live URL, and anything he should click through to double-check.

## Safety rails
- Never commit or push `.env` files or keys. If a secret ever ends up in a commit, stop and flag it before pushing.
- If `main` has half-finished work that shouldn't go live, say so and let Alex decide — don't push blind.
