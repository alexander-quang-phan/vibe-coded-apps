# Trim — Per-Chat Build Plan

> One task = one Claude Code chat. This file is the menu. Pick a task, copy its "Chat prompt" block into a fresh chat, hand it over. Don't let any chat try to do more than one item.

---

## How to use this file

**Start every new chat with this paste-ready preamble, then append the task's own Chat prompt:**

```
Before coding, read these three files and treat them as the source of truth:
- /Users/alexphan_bon/Vibe Coded Apps/Trim (Budgeting App)/ARCHITECTURE.md
- /Users/alexphan_bon/Vibe Coded Apps/Trim (Budgeting App)/FEATURES.md
- /Users/alexphan_bon/Vibe Coded Apps/Trim (Budgeting App)/SECURITY.md
- /Users/alexphan_bon/Vibe Coded Apps/Trim (Budgeting App)/BUILD_PLAN.md

Rules:
- Only do the one task below.
- Do not change architecture or add features not in the task.
- Do not create duplicate files. If a file already exists, edit it.
- If something is ambiguous, ASK before guessing.
- When done: summarise what changed, list files touched, update the checkbox in BUILD_PLAN.md, and update the relevant doc (ARCHITECTURE / FEATURES / SECURITY) if the change affects it.

Task: <paste the Chat prompt from BUILD_PLAN.md here>
```

---

## Status summary

| Phase | Status | Notes |
| --- | --- | --- |
| 0 – Setup | ✅ | Node installed, deps installed, .env templates created (user pastes Supabase values). |
| 1 – Server API | ✅ | me, categories, transactions, dashboard, budgets, analytics, goals all wired behind `requireAuth`. |
| 2 – Client shell + Dashboard | ✅ | Router, auth, theme, quick-add, celebrations. |
| 3 – UI primitives | ✅ | Select, Textarea, Skeleton, Alert, Progress. |
| 4 – MVP pages | ✅ | Budgets, Transactions, Analytics, SavingsGoals, Settings. |
| 5 – Wiring | ✅ | SavingsGoals route + nav link added. |
| Service-role grants repair | ✅ | Added migration 002 to fix `permission denied for table ...` after SQL setup. |
| **6 – Deferred features** | **⏳** | **One chat each. See tasks below.** |
| 7 – Deploy | ⏳ | Separate chat. |

---

## ⬇ Anchor (restate at the top of any long chat)

- Docs: ARCHITECTURE.md · FEATURES.md · SECURITY.md · BUILD_PLAN.md (repo root).
- **Golden rules:** 3 taps to log · celebrate loudly, fail quietly · dark-mode first · deep emerald accent · mobile-first · never red for overspending (rose-400) · currency always read from `/api/me`.
- **Stack:** React+Vite / Express / Supabase (service-role server-only, RLS on everything, browser uses anon key for Auth only).
- **If asked for an architectural decision not in the spec**, ASK via options with a recommended default before picking.

---

## Phase 6 — Deferred features (one chat per task)

Pick any. They're independent and can be done in any order. Each task block below is ready to paste.

### ▢ Task 6.1 — Wins feed on Dashboard

**Chat prompt:**
```
Add a "Wins feed" card to the Dashboard.

What: A scrollable card at the bottom of the Dashboard (above the FAB) showing a reverse-chronological list of recent positive events:
- "You stayed under budget on Food this week — £18 saved"
- "5-day streak! 🔥"
- "Shield earned — two banked"
- "£100 added to Emergency fund (12% → 20%)"

How:
- Server: new endpoint GET /api/wins that derives events from existing data (transactions vs budgets, streak milestones from user_stats, shields earned, savings contributions). Return at most 10 events, each with { type, title, body, at, icon }.
- Client: components/WinsFeed.jsx that fetches ['wins'] and renders a list of event rows. Mount it on Dashboard below RecentTransactions.
- No new DB tables — derive from what's there.
- Keep copy playful (FEATURES.md tone rules).

Out of scope: push notifications, edit/dismiss, weekly digest (see 6.2).
```

---

### ▢ Task 6.2 — Weekly digest card (Sunday summary)

**Chat prompt:**
```
Add a "This week in Trim" digest card to the Dashboard, shown Sundays and Mondays.

What: One card summarising the prior 7 days: total spent, total earned, streak progress, biggest category, one tip picked from a list. Dismissible for the week (localStorage key `trim-digest-dismissed-<yyyy-ww>`).

How:
- Server: GET /api/digest/weekly — aggregates last 7 days, returns { spent, earned, streak, topCategory, tip }.
- Client: components/WeeklyDigest.jsx — only renders if (a) it's Sun or Mon and (b) not dismissed.
- Tone per FEATURES.md: celebrate wins, no shaming.

Out of scope: email digest, push notifications.
```

---

### ▢ Task 6.3 — Recurring transactions executor

**Chat prompt:**
```
Implement recurring transactions.

Schema already has transactions.is_recurring. Extend with a recurrences table OR add recurrence fields (interval, next_run_at) to transactions — pick one and justify in the chat.

What:
- A user can mark a transaction "recurring" (monthly/weekly) when creating it.
- A Supabase Edge Function or Railway cron runs daily at 03:00 UTC, finds due recurrences, inserts transactions for today, advances next_run_at.
- The UI has a "Recurring" badge on affected rows and a toggle in the quick-add dialog.

Before coding, decide:
- Table shape (one new recurrences table, or extra columns on transactions).
- Executor venue (Supabase Edge Function vs. Railway cron).

Ask the user to confirm both choices before writing code.
```

---

### ▢ Task 6.4 — Profile / Achievements page

**Chat prompt:**
```
Add /profile — a page showing badges and lifetime stats.

What:
- Grid of badges (earned + locked). Each badge card has icon, title, description, earned-at date or "Locked".
- Lifetime stats block: total transactions, lifetime XP, longest streak, total saved across goals.
- Pulls from /api/me (already has stats.badges — empty array today).

Before coding:
- Badge set is not defined yet. Propose ~8 meaningful badges (e.g. "3 months under budget on Food", "£1000 saved", "30-day streak", "First expense logged") and ASK the user to approve before implementing award logic.
- Once approved: add a pure function in server/lib/gamification.js that computes badge awards when relevant events fire (transaction log, goal contribution, budget period rollover).

Out of scope: social sharing, profile pictures.
```

---

### ▢ Task 6.5 — Custom categories CRUD in Settings

**Chat prompt:**
```
Add a "Manage categories" section to Settings.

What:
- List existing categories (grouped by type: expense / income).
- Add, rename, delete (with confirm; fail deletion if any transaction references it OR offer "reassign to Other").
- Change icon (emoji picker from SavingsGoals EMOJI_CHOICES) and colour.

How:
- Server: extend server/routes/categories.js with POST, PATCH /:id, DELETE /:id. Validate with Zod. On delete, check for referencing transactions first and return 409 if any exist.
- Client: components/CategoryManager.jsx dropped into Settings below Preferences.

Out of scope: category order, archiving.
```

---

### ▢ Task 6.6 — Simple mode UI

**Chat prompt:**
```
When user_stats.simple_mode is true, Dashboard and Quick-Add should collapse to a single-monthly-total flow.

What:
- Settings already has the toggle — it writes to user_stats.simple_mode.
- When simple_mode is on:
  - Dashboard replaces CategoryDonut + BudgetAlerts with a single "This month" card: one progress bar vs. the user's monthly limit (new field user_stats.monthly_limit — add it).
  - QuickAddDialog hides the category chip grid; amount + tap "Log" instead (this breaks the 3-tap rule from 3 taps to 2 — acceptable in simple mode).

Before coding:
- Add user_stats.monthly_limit column (nullable numeric). Write a small migration file in server/migrations/.
- Ask the user whether the limit should have a default or always be explicitly set first.
```

---

### ▢ Task 6.7 — Deploy to Railway

**Chat prompt:**
```
Prepare Trim for Railway deployment.

What:
- Add railway.toml (or railway.json) at repo root, plus any needed build commands.
- Client: decide whether Railway serves the Vite build as a static service or whether the Express server serves it. Recommend static service — ASK the user to confirm.
- Add a production CLIENT_URL placeholder to SECURITY.md's deployment checklist once it exists.
- Document required env vars in a DEPLOY.md file at repo root (not ARCHITECTURE.md).

Before coding: confirm Railway service count (1 or 2), domain setup, and whether the user wants preview environments.
```

---

## Deferred further (flagged in FEATURES.md, don't start without explicit ask)

- Push notifications / email digest
- Friend leaderboard
- Category-level savings goals
- Multi-currency per-transaction (we're single-currency-per-user by design)

---

## Working agreement (copy into any long chat)

1. Do one task. Stop at the end.
2. Don't create duplicate files — `ls` / `Glob` first.
3. Don't silently change architecture.
4. Ask via AskUserQuestion with a recommended default for anything not in the docs.
5. At the end: summarise files changed, tick the checkbox in this file, update docs if rules shifted.
