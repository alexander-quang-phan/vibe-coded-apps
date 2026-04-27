# Trim — Per-Chat Build Plan

> One task = one Claude Code chat. This file is the menu. Pick a task, copy its "Chat prompt" block into a fresh chat, hand it over. Don't let any chat try to do more than one item.

---

## How to use this file

**Start every new chat with this paste-ready preamble, then append the task's own Chat prompt:**

```
Before coding, read these files and treat them as the source of truth:
- /Users/alexphan_bon/Vibe Coded Apps/Trim (Budgeting App)/ARCHITECTURE.md
- /Users/alexphan_bon/Vibe Coded Apps/Trim (Budgeting App)/FEATURES.md
- /Users/alexphan_bon/Vibe Coded Apps/Trim (Budgeting App)/SECURITY.md
- /Users/alexphan_bon/Vibe Coded Apps/Trim (Budgeting App)/BUILD_PLAN.md

Rules:
- Do exactly the one task below. Stop when it's done.
- Do not change architecture or add features not in the task.
- Do not create duplicate files. `ls` / `Glob` first; if a file exists, edit it.
- If anything is ambiguous, ASK before guessing. Use AskUserQuestion with a recommended default.
- If you find yourself making more than two architectural decisions, stop and check in.
- When done: summarise files changed, list any decisions made, tick the checkbox in BUILD_PLAN.md, and update the relevant doc (ARCHITECTURE / FEATURES / SECURITY) only if behaviour changed.

Task: <paste the Chat prompt from BUILD_PLAN.md here>
```

---

## Status summary

| Phase | Status | Notes |
| --- | --- | --- |
| 0 – Setup | ✅ | Node installed, deps installed, .env templates created. |
| 1 – Server API | ✅ | me, categories, transactions, dashboard, budgets, analytics, goals all behind `requireAuth`. |
| 2 – Client shell + Dashboard | ✅ | Router, auth, theme, quick-add, celebrations. |
| 3 – UI primitives | ✅ | Select, Textarea, Skeleton, Alert, Progress. |
| 4 – MVP pages | ✅ | Budgets, Transactions, Analytics, SavingsGoals, Settings. |
| 5 – Wiring | ✅ | SavingsGoals route + nav link added. |
| Service-role grants repair | ✅ | Migration 002 fixes `permission denied for table ...`. |
| Savings contribution note repair | ✅ | Migration 003 aligns contribution notes with the API/UI. |
| Visual polish pass | ✅ | Mesh background, glass chrome, hero balance, animated streak/XP/FAB, hover-lift cards, gradient progress. |
| **6 – Deferred features** | **⏳** | **One chat each. See tasks below.** |
| 7 – Deploy | ⏳ | Separate chat (Task 6.15). |

---

## ⬇ Anchor (restate at the top of any long chat)

- Docs: ARCHITECTURE.md · FEATURES.md · SECURITY.md · BUILD_PLAN.md (repo root).
- **Golden rules:** 3 taps to log · celebrate loudly, fail quietly · dark-mode first · deep emerald accent · mobile-first · never red for overspending (rose-400 only) · currency always read from `/api/me`.
- **Stack:** React+Vite / Express / Supabase (service-role server-only, RLS on everything, browser uses anon key for Auth only).
- **Architectural decisions not in the spec:** ASK with options + a recommended default.

---

## Phase 6 — Build order rationale

Tasks are ordered by impact-per-chat-hour, grounded in the research on why budget apps fail (guilt loop, reactive-not-proactive, discipline collapse, rigid categories). Don't feel obliged to follow strictly — they're independent — but the top tier is where retention actually moves.

- **Tier 1 (6.1–6.6):** Move-the-needle features. Counter the four failure modes directly.
- **Tier 2 (6.7–6.10):** Differentiators. Things competitors don't do well or at all.
- **Tier 3 (6.11–6.14):** Friction reducers and retention scaffolding. Useful, lower urgency.
- **6.15:** Deploy.

---

## Tier 1 — Move-the-needle features

### ✅ Task 6.1 — Wins feed on Dashboard

**Chat prompt:**
```
Add a "Wins feed" card to the Dashboard.

What: A scrollable card at the bottom of the Dashboard (above the FAB) showing a reverse-chronological list of recent positive events:
- "You stayed under budget on Food this week — £18 saved"
- "5-day streak! 🔥"
- "Shield earned — two banked"
- "£100 added to Emergency fund (12% → 20%)"

How:
- Server: GET /api/wins. Derives events from existing data (transactions vs budgets, streak milestones from user_stats, shields earned, savings contributions). Returns at most 10 events, each with { type, title, body, at, icon }. Sorted by `at` desc.
- Client: components/WinsFeed.jsx fetches ['wins'] and renders rows. Mount on Dashboard below RecentTransactions.
- Empty state (new user, no events yet): friendly placeholder line, e.g. "Your wins will show up here as you go." NEVER hide the card silently — empty card is part of the experience.
- No new DB tables — derive from what's there.
- Copy is playful, FEATURES.md tone rules. Never shaming, never red.

Acceptance criteria:
- New user with zero data sees the empty-state card.
- After logging a transaction that keeps a category under budget for the week, an event appears.
- Events older than 14 days are not returned.

Out of scope: push notifications, edit/dismiss, weekly digest (Task 6.13).
```

---

### ✅ Task 6.2 — Subscription manager

**Chat prompt:**
```
Add a Subscriptions page that auto-detects recurring charges and lets the user audit them. This is the single feature that gives users an "I just saved £X because of Trim" moment — front-load it.

What:
- Auto-detect recurring expenses from the existing transactions table (no new schema needed for detection itself).
- New page /subscriptions: list of detected subs with monthly cost, annualised cost, last charged, next expected, total paid lifetime.
- Each row has a status toggle — Active / Cancelled. Marking Cancelled hides it from the active list and adds a positive event ("£12.99/mo cancelled — that's £155.88 a year back") that flows into the Wins feed (Task 6.1) if present.
- Dashboard mini-card: "You have N subscriptions, £X/month — audit them?" linking to the page. Mounts above CategoryDonut.

How:
- Detection in server/lib/subscriptions.js — pure function on a user's transactions. Default rule: ≥3 charges from the same normalised merchant string at ~30-day or ~365-day intervals (±5 day tolerance), amounts within 10% of each other. Normalise merchant by lowercasing, stripping punctuation, taking first 2–3 words.
- Persistence: new subscription_overrides table { user_id, merchant_key, status ('active'|'cancelled'), decided_at }. Detection always runs fresh; overrides layer on top.
- Server: GET /api/subscriptions returns detected + override-merged list. PATCH /api/subscriptions/:merchantKey updates status.
- Client: pages/Subscriptions.jsx, components/SubscriptionRow.jsx, components/SubscriptionsCard.jsx (Dashboard).
- Empty state (no detected subs): friendly placeholder. Don't hide the page link.

Before coding, ASK with recommended defaults:
- Cadence threshold: ≥3 occurrences (recommended) vs ≥2.
- Include income recurrences (salary etc.) as a separate "Money in" section, or expenses only? (Recommend expenses only for v1.)

Acceptance criteria:
- A user with ≥3 monthly Netflix-equivalent charges sees Netflix on the page.
- Marking a sub Cancelled hides it from the active list and surfaces savings in the Wins feed (if 6.1 done).
- Re-running detection after a new month doesn't lose user override decisions.

Out of scope: cancellation links/automation (legal landmine), price-change alerts, free-trial detection, fetching merchant logos.
```

---

### ▢ Task 6.3 — Month-end projection card

**Chat prompt:**
```
Add a "Month-end projection" card to the Dashboard so users see where they're headed, not just where they've been. Direct counter to the reactive-not-proactive failure mode.

What: A card high on the Dashboard (above CategoryDonut) showing where the user lands at month-end if they keep spending at the current pace:
- Projected total spend by month-end.
- Delta vs. monthly budget — "On pace to land £42 under" or "On pace to overshoot by £85".
- One-line pace label: "spending faster than last month" / "tracking calmly" / "ahead of pace".
- Tone: celebratory when under, gentle nudge (rose-400, sparingly) when over. NEVER shaming.

How:
- Server: GET /api/projections/month — returns { projectedSpend, monthlyBudget, delta, daysElapsed, daysInMonth, paceLabel }. Pure derivation from transactions + budgets.
- Math: projectedSpend = (spendSoFarThisMonth / daysElapsed) * daysInMonth. Linear extrapolation, intentionally simple.
- Client: components/MonthProjection.jsx, mounted on Dashboard above CategoryDonut.
- Edge cases: on day 1 of month with zero transactions, show "too early to tell — log a few days first." Don't show garbage projections from one outlier transaction.
- Hide entirely when user_stats.simple_mode is true (Task 6.5 has its own card).

Before coding, ASK:
- Simple linear extrapolation (recommended for v1) vs weighting recent days more heavily? Linear is harder to mislead with one bad day and easier to explain.

Acceptance criteria:
- New month, zero transactions: shows the "too early" copy, no number.
- Mid-month with normal data: shows a sensible projection within ±20% of a hand calculation.
- Last day of month: projection ≈ actual spend.

Out of scope: per-category projections, multi-month forecasting, charts.
```

---

### ▢ Task 6.4 — "Can I afford this?" widget

**Chat prompt:**
```
Add a "Can I afford this?" check on the Dashboard so users can stress-test a purchase BEFORE they make it (the moment most apps miss).

What: A small inline form on the Dashboard where the user enters a hypothetical amount and category, and Trim immediately shows the impact:
- Remaining in that category for the month after the hypothetical purchase.
- Remaining total monthly budget after.
- Effect on top savings goal pace ("delays Vietnam fund by ~6 days at your current contribution rate").
- Friendly verdict line: "Comfortably yes" / "Tight but yes" / "Would push you over". NEVER the words "you can't afford it" — Trim doesn't moralise.

How:
- Server: POST /api/affordability — body { amount, categoryId? }. Returns { categoryRemaining, totalRemaining, goalImpactDays, verdict }. NO DB writes — pure read + compute.
- Client: components/AffordabilityCheck.jsx, mounted under the hero balance. Compact: one amount input, one category chip row (reuse existing chip styles), instant result row beneath. Debounce input by 300ms.
- Hide in simple_mode.
- Edge cases: user has no savings goals → omit the goalImpactDays line, don't crash. User has no monthly budget set → fall back to "no budget set yet" instead of NaN.

Before coding, ASK:
- Which savings goal to use for goalImpactDays — the one with the soonest target date (recommended) or the largest remaining amount? No "primary" flag exists yet.

Acceptance criteria:
- Entering a small amount under a healthy category → "Comfortably yes" + accurate remaining.
- Entering an amount > category remaining → "Would push you over" but never red language.
- User with no goals doesn't see a goal-impact line.

Out of scope: saving check history, scenario comparison, recurring "what if I bought this every month" simulation.
```

---

### ▢ Task 6.5 — Simple mode UI

**Chat prompt:**
```
When user_stats.simple_mode is true, Dashboard and Quick-Add collapse to a single-monthly-total flow. Direct response to the "tracking everything kills retention" research finding.

What:
- Settings already has the toggle — it writes to user_stats.simple_mode.
- When simple_mode is on:
  - Dashboard replaces CategoryDonut + BudgetAlerts with a single "This month" card: one progress bar vs the user's monthly limit (new field user_stats.monthly_limit). Big number, calm copy: "£420 left this month" not "£580 spent of £1000".
  - QuickAddDialog hides the category chip grid; amount + tap "Log" instead. This breaks the 3-tap rule (now 2 taps) — explicitly acceptable in simple mode.
  - Hide MonthProjection (6.3), AffordabilityCheck (6.4), and CategoryDonut. Keep RecentTransactions and WinsFeed (6.1).
- Toggle should take effect without page refresh — invalidate `/api/me` and re-render.

How:
- Migration: add user_stats.monthly_limit (nullable numeric) in server/migrations/.
- Server: include monthly_limit in /api/me response. PATCH /api/me/preferences accepts it.
- Client: branch in Dashboard.jsx and QuickAddDialog.jsx on `me.stats.simple_mode`. Add a SimpleMonthCard component.

Before coding, ASK:
- Should monthly_limit have a default (e.g. £1000) or always be explicitly set first run? Recommend EXPLICIT — the act of choosing the number is the meaningful behavioural moment, defaults undermine it.
- On switching simple_mode ON for a user with no monthly_limit set: prompt them inline ("Set your monthly limit") or take them to Settings? Recommend inline prompt on the Dashboard so they don't get bounced around.

Acceptance criteria:
- Toggling simple_mode in Settings updates the Dashboard within 1 second.
- Simple-mode QuickAdd logs a transaction in 2 taps (amount → Log).
- Logged transactions still record category as 'Other' or a configurable default.

Out of scope: full hidden-category mode (transactions still need a category in the DB, just hidden in UI), per-week limits.
```

---

### ▢ Task 6.6 — Natural-language quick-add (AI parser)

**Chat prompt:**
```
Add an AI-powered freeform input to QuickAddDialog so users can type "spent 12 quid on tacos last night" and get a structured transaction back.

What:
- "Type it instead" toggle in QuickAddDialog opens a single text field.
- On submit, server calls Claude with the user's text + their category list, parses to JSON.
- Pre-fills the structured form so the user CONFIRMS or edits before saving. NEVER auto-saves.
- On parse failure or low confidence: show "couldn't quite read that — mind trying again?" and let the user fall back to manual entry.

How:
- Server: POST /api/transactions/parse, body { text }. Calls Anthropic Messages API with a strict JSON-only system prompt and the user's category list inlined. Validates response with Zod before returning.
- Expected response shape: { amount: number (minor units), currency: string, categoryId: string|null, description: string, occurredAt: ISO date, confidence: 'high'|'medium'|'low' }. Low confidence → categoryId is null and the chip row stays unselected.
- ANTHROPIC_API_KEY in server env — never exposed to browser.
- Client: extend QuickAddDialog with toggle + parser path. Loading state while waiting on the API. On success, switch back to the structured form pre-filled.

Before coding, ASK:
- Model: claude-haiku-4-5 (recommended — cheap, fast, JSON-shaped output is well within capability) vs claude-sonnet-4-6 (better at edge cases). Start with Haiku.
- max_tokens: 200 (recommended) — JSON output should be tiny. Confirms prompt design is tight.
- Default occurredAt when text gives no date: today (recommended) vs ask the user.

Acceptance criteria:
- "spent 12 quid on tacos last night" → amount 1200, GBP, Dining Out (or Food, depending on user's categories), description "tacos", occurredAt = yesterday, confidence high.
- "two coffees and a sandwich" → amount populated, description preserves the items, confidence medium, category may or may not match.
- Gibberish → friendly fallback, no crash.

Out of scope: voice input, multi-transaction parsing in one message, receipt OCR.
```

---

## Tier 2 — Differentiators

### ▢ Task 6.7 — Stashes (envelope mode)

**Chat prompt:**
```
Add an opt-in envelope-style budgeting mode. Calls them "stashes" in UI to differentiate from the existing budgets feature. Inspired by the cash-stuffing aesthetic that's huge with the 18–28 demographic on TikTok — this is a brand moment as much as a feature.

What:
- At the start of each month the user "fills" stashes with allocated amounts per category.
- As they log expenses, the relevant stash visually drains (animated bar going down, satisfying).
- Empty stash = greyed-out card with soft "this stash is empty" label. Never red.
- Different from budgets: a budget is a target you compare against; a stash is real allocated money that runs out.

How (proposed — confirm before coding):
- Schema: new stashes table { id, user_id, category_id, period (yyyy-mm), allocated_minor, spent_minor }. spent_minor derived live from transactions; allocated_minor user-set.
- Server: GET/POST /api/stashes, PATCH /api/stashes/:id, POST /api/stashes/refill (idempotent, called by user or cron at month start).
- Client: components/StashesView.jsx — grid of envelope-style cards with a fill animation on month start. Replaces BudgetAlerts on Dashboard when envelope mode is on.
- Settings toggle user_stats.envelope_mode (boolean, default false).

Before coding, ASK with recommended defaults:
- Should envelope_mode REPLACE the existing budgets feature for that user, or run alongside? (Recommend REPLACE — having both is confusing.)
- End-of-month leftover behaviour — rollover to next month, sweep to a chosen savings goal, or user picks per stash? (Recommend "user picks per stash, default rollover".)
- UI naming: "stashes" vs "envelopes"? (Recommend "stashes" — fits Trim's tone better, less Dave-Ramsey-coded.)

Acceptance criteria:
- Toggling envelope_mode on shows the stash grid within a second.
- Logging a transaction drains the corresponding stash visibly.
- Month rollover triggered manually creates fresh stashes with last month's allocations as defaults.

Out of scope: physical/cash-stuffing tracking, multi-currency stashes, sub-stashes within a category, sharing stashes between users.
```

---

### ▢ Task 6.8 — Mood tags on transactions

**Chat prompt:**
```
Add an optional mood/context tag to transactions so we can surface emotional-spending insights — the lever behavioural research says actually changes habits (vs just showing categories).

What:
- When logging a transaction, an optional row of mood emoji chips after amount + category: 😌 planned · 😣 stressed · 🥳 social · 🍕 hungry · 😶 bored · ⚪ skip.
- Skippable in 1 tap (default = skip). Does NOT break the 3-tap rule.
- New Analytics card "Mood patterns": insight strings like "You spend ~2.4× more when stressed" or "Sundays are your most expensive mood day". Only render after ≥20 tagged transactions to avoid noise.

How:
- Schema: add transactions.mood_tag (nullable text, app-side enum: planned | stressed | social | hungry | bored | null).
- Server: include mood_tag in transaction create/update payload. New endpoint GET /api/analytics/mood — aggregates avg spend by mood, returns top 1–2 insight strings + raw counts.
- Client: extend QuickAddDialog with a mood chip row below category (visually lighter, clearly optional — smaller chips, lower opacity). Add MoodInsightCard to Analytics page.

Before coding, ASK:
- Confirm the mood set above (5 + skip), or propose a different list. Keep ≤5 — more = decision fatigue, defeats the purpose.
- Hide mood row in simple_mode? (Recommend YES — simple_mode is about minimum friction.)

Acceptance criteria:
- Existing transactions still load fine with null mood_tag.
- Logging without picking a mood works exactly as before (no extra tap).
- After 20 tagged transactions with clear pattern, the insight card renders with sensible copy.

Out of scope: bulk-tagging past transactions, free-text mood notes, mood-based notifications, sharing mood data.
```

---

### ▢ Task 6.9 — Smart category suggestion (merchant memory)

**Chat prompt:**
```
When the user logs a transaction, suggest a category based on the merchant/description they've used before. Reduces the 3-tap log to effectively 2 taps for repeat merchants without ever silently overriding intent.

What:
- On QuickAddDialog, as the user types description, suggest the category they most often use for that merchant.
- First-time merchants: fall back to a small built-in keyword map (e.g. "tesco" / "sainsbury" → Groceries, "uber" / "lyft" → Transport, "pret" / "starbucks" → Dining Out).
- Suggestion is a HIGHLIGHT on the suggested chip (deep emerald ring) — does NOT auto-select. User still taps to confirm.
- Why highlight-only: a wrong silent auto-categorisation is much more annoying than a missed highlight.

How:
- Server: GET /api/categories/suggest?desc=... — returns { categoryId, confidence, source: 'history' | 'keyword' | 'none' }. SQL: top category for this user's transactions matching description (case-insensitive ILIKE on first 2 words, ordered by count).
- Server: keyword map in server/lib/categoryKeywords.js — small hand-curated list, easy to extend.
- Client: extend QuickAddDialog. Debounce description input by 250ms, fetch suggestion, apply highlight ring to the suggested chip.

Before coding, ASK:
- Highlight only (recommended), or auto-select on high confidence (e.g. >5 prior matches)? Highlight-only is easier to reason about and avoids "why did it pick that?" complaints.

Acceptance criteria:
- After logging "Pret" 3 times as Dining Out, typing "pret" again highlights Dining Out.
- First-time "Tesco" highlights Groceries via keyword map.
- Unknown merchant ("Gleemwaffle") → no highlight, no error.

Out of scope: LLM-based suggestion (already covered by Task 6.6 parser), bulk re-categorisation of past transactions, user-editable rules engine.
```

---

### ▢ Task 6.10 — Ask Trim chat

**Chat prompt:**
```
Add an "Ask Trim" tab where the user asks natural-language questions about their finances and gets an answer grounded in their actual data.

What:
- New page /ask. Single chat interface, deep emerald accent, glassmorphic to match the rest of the app.
- User asks things like "Can I afford a £600 trip to Vietnam in March?" / "Where am I overspending most?" / "How long until my emergency fund hits £2000?"
- Server assembles a context bundle (last 90 days of transactions, current budgets, savings goals, user_stats) and passes to Claude with a system prompt grounding it as a friendly, non-judgmental money assistant in the Trim tone (FEATURES.md rules — never red, never shaming, celebrate wins, plain language).
- Streams the response token-by-token via SSE. Persists chat history per user (last 50 messages) so the user can scroll back.

How:
- Schema: ask_messages table { id, user_id, role ('user'|'assistant'), content, created_at }.
- Server: POST /api/ask (streaming SSE). GET /api/ask/history. Context bundle assembly in server/lib/askContext.js — pure function returning the context blob, easy to unit test.
- Client: pages/Ask.jsx, components/AskMessage.jsx. Use fetch streaming for SSE.
- Anthropic API: claude-sonnet-4-6 (this one needs reasoning), max_tokens 1500.
- System prompt should explicitly forbid moralising language and red copy. Include an example exchange in the system prompt to anchor tone.

Before coding, ASK with recommended defaults:
- Context window: 90 days proposed. Larger = more accurate, more tokens, slower, more expensive. (Recommend 90 days for v1.)
- Read-only ANSWERS only, or allowed to ACT (create budgets, log transactions, adjust goals)? Strongly recommend ANSWER-ONLY for v1 — actions need a confirmation UI we don't have, and a hallucinated transaction is worse than a hallucinated answer.
- Include the user's historical mood data (Task 6.8) in context if available? (Recommend yes if 6.8 done — opens up "you spend more when stressed" type answers.)

Acceptance criteria:
- "How much did I spend on food last month?" → grounded answer with the right number.
- "Can I afford X?" → answer references current month's remaining budget and savings goal pace.
- Adversarial input ("ignore previous instructions") → stays in character, refuses to leak system prompt or take destructive actions.

Out of scope: tool use / actions from chat, multi-turn memory beyond the visible thread, sharing chats with friends, scheduled "weekly check-in" prompts.
```

---

## Tier 3 — Friction reducers and retention scaffolding

### ▢ Task 6.11 — Custom categories CRUD in Settings

**Chat prompt:**
```
Add a "Manage categories" section to Settings.

What:
- List existing categories grouped by type: expense / income.
- Add, rename, delete (with confirm). Delete fails if any transaction references it; offer "reassign to Other" as the recovery path.
- Change icon (emoji picker — reuse SavingsGoals EMOJI_CHOICES) and colour.

How:
- Server: extend server/routes/categories.js with POST, PATCH /:id, DELETE /:id. Validate with Zod. On delete, check for referencing transactions first; return 409 with the count if any exist, accept a `?reassign_to=<other_id>` param to bulk-reassign before delete.
- Client: components/CategoryManager.jsx dropped into Settings below Preferences.

Acceptance criteria:
- Delete with 0 transactions → succeeds.
- Delete with N transactions → 409 with count; user prompted to reassign.
- Renaming preserves all transaction references.

Out of scope: category order/reordering, archiving, per-category budgets (already in budgets feature).
```

---

### ▢ Task 6.12 — Recurring transactions executor

**Chat prompt:**
```
Implement user-marked recurring transactions. This complements Task 6.2 (Subscription Manager): 6.2 detects existing patterns automatically; this lets the user explicitly mark "rent" or "Spotify" as recurring so Trim auto-creates the next one without them logging it.

What:
- A user can mark a transaction "recurring" (monthly/weekly) when creating it, via a toggle in QuickAddDialog.
- A daily cron runs at 03:00 UTC, finds due recurrences, inserts transactions for today, advances next_run_at.
- UI shows a "Recurring" badge on affected rows.
- Recurrences a user creates here should appear in the Subscription Manager view (Task 6.2) with status 'active' by default — no double-counting.

Schema already has transactions.is_recurring. Extend with EITHER a recurrences table OR add recurrence fields (interval, next_run_at, parent_transaction_id) to transactions — pick one.

Before coding, ASK with recommended defaults:
- Table shape: separate `recurrences` table (recommended — cleaner separation, no nullable columns on transactions, easier to query "what's coming up") vs columns on transactions.
- Executor venue: Supabase Edge Function vs Railway cron. Recommend RAILWAY CRON — keeps execution in the same environment as the rest of the server, simpler to debug.
- If Subscription Manager (6.2) is built: how should manually-recurring transactions appear there? Recommend: shown as 'active' subscriptions with a small "manually marked" tag.

Acceptance criteria:
- Marking a transaction recurring (monthly), tomorrow's cron creates a new transaction with the same amount/category/description.
- Cancelling a recurrence stops future creations but keeps history.
- The cron is idempotent — running twice doesn't double-create.

Out of scope: variable-amount recurrences ("£12–18 for groceries"), multi-step recurrences, mid-cycle changes.
```

---

### ▢ Task 6.13 — Weekly digest card (Sunday summary)

**Chat prompt:**
```
Add a "This week in Trim" digest card to the Dashboard, shown Sundays and Mondays.

What: One card summarising the prior 7 days, ending with ONE specific suggested action the user can tap to complete this week. The action prompt is the point — research is clear that knowing isn't doing, so a passive recap on its own won't move behaviour.

The card shows:
- Total spent, total earned.
- Streak progress (current streak length, days to next milestone).
- Biggest category by spend.
- One tip line.
- ONE action button: e.g. "Bump emergency fund by £20 this week" / "Set a stash for next month" / "Log this weekend's expenses now". Tapping it deep-links to the relevant page or opens QuickAddDialog pre-filled.

Dismissible for the week (localStorage key `trim-digest-dismissed-<yyyy-ww>`).

How:
- Server: GET /api/digest/weekly — aggregates last 7 days, returns { spent, earned, streak, topCategory, tip, action: { label, deeplink, prefill? } }.
- Action selection logic: pick the most relevant action based on user state. Order of preference: (1) emergency fund < target → bump suggestion; (2) any goal close to milestone → contribute suggestion; (3) unlogged days in last 7 → log reminder; (4) generic tip if none apply.
- Client: components/WeeklyDigest.jsx — renders only if (a) it's Sun or Mon AND (b) not dismissed.
- Tone per FEATURES.md: celebrate wins, no shaming. The action is framed as opportunity, not obligation.

Before coding, ASK:
- Confirm the action priority order above, or adjust.

Acceptance criteria:
- Dismiss persists across sessions for the current week, returns next week.
- Action deep-link works on mobile and desktop.
- Action prefill lands the user in QuickAddDialog (or wherever) ready to confirm with one tap.

Out of scope: email digest, push notifications, multi-action prompts.
```

---

### ▢ Task 6.14 — Profile / Achievements page

**Chat prompt:**
```
Add /profile — a page showing badges and lifetime stats. This is a retention scaffolding feature (Duolingo-style), not a behaviour-change one — set expectations accordingly.

What:
- Grid of badges (earned + locked). Each badge card has icon, title, description, earned-at date or "Locked".
- Lifetime stats block: total transactions, lifetime XP, longest streak, total saved across goals.
- Pulls from /api/me (already has stats.badges — empty array today).

Before coding, ASK with recommended defaults:
- Badge set is not defined. Propose ~8 meaningful badges, BUT critical constraint: AT LEAST HALF must reward BEHAVIOURS (logged 7 days in a row, set first goal, used Trim 30 days, audited subscriptions) rather than OUTCOMES (saved £1000, longest streak, biggest category cut). Outcome-only badges feel unattainable to new users and demotivate. Behaviour badges fire often enough to keep the feedback loop alive.
  - Suggested split: 4 behaviour, 4 outcome.
  - Behaviour examples: "First expense logged", "7-day logging streak", "Reviewed your subscriptions", "Set your first stash".
  - Outcome examples: "30-day streak", "£1000 saved", "3 months under budget on Food", "Five goals completed".
- Badge unlock notification UX: Wins-feed entry only (recommended) vs modal celebration on unlock vs both. Recommend Wins feed only — modals interrupt, the streak/XP animation already serves as a celebration moment.

Once approved: pure function in server/lib/gamification.js computes badge awards when relevant events fire (transaction log, goal contribution, budget period rollover, subscription audit). Function takes user state + event, returns array of newly-earned badge IDs.

Acceptance criteria:
- New user logs first expense → "First expense logged" badge appears within 1 second on /profile.
- Locked badges show clear progress where applicable (e.g. "12 / 30 day streak").
- /profile loads in under 500ms with full badge grid.

Out of scope: social sharing, profile pictures, badge trading/showcasing.
```

---

### ▢ Task 6.15 — Deploy to Railway

**Chat prompt:**
```
Prepare Trim for Railway deployment.

What:
- Add railway.toml (or railway.json) at repo root, plus needed build commands.
- Client: decide whether Railway serves the Vite build as a static service or whether the Express server serves it.
- Add a production CLIENT_URL placeholder to SECURITY.md's deployment checklist.
- Document required env vars in a DEPLOY.md file at repo root (NOT ARCHITECTURE.md).

Before coding, ASK with recommended defaults:
- Service count: 1 service (Express serves the Vite build) vs 2 services (static client + API). Recommend 2 SERVICES — cleaner, easier to scale independently, and the static client gets cheap CDN delivery.
- Domain setup: subdomain (api.trim.app + trim.app) vs path-based (trim.app + trim.app/api). Recommend SUBDOMAIN.
- Preview environments per PR: yes/no. Recommend NO for v1 — single dev, complexity not worth it yet.

Acceptance criteria:
- Fresh clone + Railway deploy from scratch lands on a working app.
- DEPLOY.md lists every env var with one-line descriptions.
- ANTHROPIC_API_KEY (if 6.6 / 6.10 done) only on the server service.
```

---

## Deferred further (flagged in FEATURES.md, don't start without explicit ask)

- Push notifications / email digest
- Friend leaderboard / streak buddy / accountability partner
- Couples / shared-budget mode
- Anonymous benchmarking ("your dining spend is in the 30th percentile…")
- Receipt OCR / photo-to-transaction
- Open Banking / Plaid UK / TrueLayer auto-import
- Variable-income / buffer-account mode (allowance-based budgeting)
- Rollover budgets and "treat day" overrides
- Time-of-day spending insights (separate Analytics card)
- Pre-spend pause (confirmation prompt for transactions over a threshold)
- Apple Fitness-style "money rings" Dashboard hero
- iOS / Android home-screen widget for one-tap log
- Category-level savings goals
- Multi-currency per-transaction (we're single-currency-per-user by design)

---

## Working agreement (copy into any long chat)

1. Do one task. Stop at the end.
2. Don't create duplicate files — `ls` / `Glob` first.
3. Don't silently change architecture.
4. Ask via AskUserQuestion with a recommended default for anything not in the docs.
5. At the end: summarise files changed, tick the checkbox in this file, update docs only if rules shifted.
