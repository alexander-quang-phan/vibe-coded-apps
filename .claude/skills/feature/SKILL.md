---
name: feature
description: Build one Trim feature end-to-end with verification baked in. Use this whenever Alex asks to add, build, extend, improve, or fix anything in the Trim budgeting app — a feature, a screen, a button, a bug — even if he doesn't use the word "feature". Also use when he asks "check if X was added" or can't find something that was supposedly built.
---

# Build a Trim feature

Follow this sequence. The steps exist because past sessions produced features that compiled but were unreachable in the UI, and docs that silently drifted out of date.

## 1. Understand before coding
Read TRIM.md, ARCHITECTURE.md, FEATURES.md, SECURITY.md, and BUILD_PLAN.md. Then restate the task in 2–3 sentences: what will exist when done, and where in the UI Alex will see it. If the request is big (multiple features, "make it deploy-ready"), split it and confirm which piece this session covers — one session, one piece.

## 2. Implement
- Work within the existing architecture (client → Express API → Supabase; client never queries Supabase directly for data).
- Match the existing UI patterns (shadcn/ui, Tailwind, existing component styles) so nothing looks bolted on.
- If Alex must do something outside the code (SQL in Supabase, env var, dashboard toggle), stop and give exact click-by-click steps, then wait for confirmation before depending on it.

## 3. Verify — this is the step that matters
- `npm run build` in `client/` must pass; restart the server if touched.
- Launch the app and navigate to the feature. Confirm it is visible and works with a realistic flow (add a transaction, ask the chatbot, etc.).
- If it isn't reachable from the UI, it isn't done — wire up the navigation/entry point now.

## 4. Close out
- Update BUILD_PLAN.md (mark progress) and FEATURES.md (describe the new behavior). Update SECURITY.md if auth/data paths changed.
- Commit with a clear message.
- Final report to Alex must include: what was built, **exactly where to find it in the UI**, what he should manually test, and whether it still needs a merge to `main` before it can deploy.
