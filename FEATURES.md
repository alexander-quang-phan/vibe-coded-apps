# Trim — Features & Product Vision

> Features/product prompt captured here so every future session inherits the tone, UX contract, and gamification mechanics. Paired with ARCHITECTURE.md (stack/security/schema).

## Identity

- **Tagline:** "Trim your spending. Grow your savings."
- **One-liner:** A budget tracker that makes money management feel like Duolingo, not your bank app.
- **Tonal difference vs. competitors:** most budget apps are punitive — they flash red when you overspend and make you feel bad. Trim celebrates wins loudly and handles slips gently.

## Core philosophy

1. **Dopamine > guilt.** Every interaction should lean toward positive reinforcement.
2. **Max 3 taps to log a transaction.** Amount → Category → Done. The category tap auto-submits. Anything extra (date, note) is progressive disclosure.
3. **Celebrate wins loudly, fail quietly.** Confetti, toasts, level-ups, shield banners when things go well. Amber→rose gradients and friendly copy ("want to adjust next month?") when things don't.
4. **Simple mode exists.** New users can opt for "one total monthly limit, no categories" — stored on `user_stats.simple_mode`.
5. **Mobile-first.** Everything must feel great on a phone. Safe-area bottom padding, big tap targets, FAB for quick-add.

## Gamification mechanics (locked in `server/lib/gamification.js`)

- **Streak:** consecutive days a transaction was logged. Tracked on `user_stats.current_streak` + `longest_streak`.
- **Streak shield:** auto-earned at every 7-day streak milestone (crossing 7, 14, 21…). Max 2 banked. Missing a day auto-consumes one if available — the streak survives.
- **XP:** +10 per transaction log (`XP_PER_LOG`).
- **Level:** `floor(xp / 100) + 1` (`XP_PER_LEVEL = 100`).
- **Level titles ladder:**
  - 1 – Budget Beginner
  - 5 – Penny Pincher
  - 10 – Coin Collector
  - 15 – Savvy Spender
  - 20 – Money Monk
  - 30 – Budget Ninja
  - 50 – Trim Master
  - 75 – Finance Sage
  - 100 – Legend
- **Celebration hooks (client/src/lib/confetti.js):**
  - `celebrateLevelUp` — green + gold fountains on level-up
  - `celebrateStreakMilestone` — orange/red burst every 7-day milestone
  - `celebrateShieldEarned` — blue burst when a shield is banked
  - `celebrateGoalMilestone` — green/gold burst at 25 / 50 / 75%
  - `celebrateGoalCompleted` — full fountain when a savings goal hits 100%
- **Badges:** meaningful only (e.g. "3 months under budget on Food"). Schema has `user_stats.badges jsonb[]` but badges are **not implemented yet**.

## Pages (MVP)

### Dashboard (the heart)

- Hero balance card (this month income − expenses) with In/Out chips; net number animates up and scales to 7xl on desktop.
- **PulseStrip** (2026-07 bolder pass — replaced the old grid of identical stat cards + separate level card): one hairline-divided instrument cluster. Focal streak segment (flame icon, big number, warm glow; sub shows shields banked or longest streak) | shields gauge ("1 per 7-day run") | logged-this-month gauge | level segment with title ladder + gold-tipped XP bar. 2×2 on mobile, one row on lg. Lives in `client/src/components/PulseStrip.jsx`.
- Month-end projection card (above the category card) — linear extrapolation of current-month spend, delta vs. summed monthly budgets, one-line pace label vs. last month's total. Cold-start guard until day 3 with ≥1 transaction; outlier guard counts a single dominant charge (>40% of spend-so-far, i.e. rent) once instead of extrapolating it. Hidden in simple_mode (SimpleMonthCard owns that slot).
- "Can I afford this?" check (under the hero) — compact amount input + horizontal expense-category chip row, debounced 300ms. Calls `POST /api/affordability` and renders three remaining/impact lines plus a friendly verdict ("Comfortably yes" / "Tight but yes" / "Would push you over"). Goal-impact line uses the soonest-target_date open goal; line is omitted when there are no open goals or no recent contributions. Hidden in simple_mode.
- "This month by category" card (Task 6.A merged the old donut + budget-alerts pair): donut + top-5 list + a "Budgets to watch" column of categories ≥75% used, one card. Hidden in simple_mode (replaced by the SimpleMonthCard).
- Recent 5 transactions + a 3-entry "Recent wins" peek side-by-side (lg). The peek links to /wins, which hosts the full feed (latest 10, playful empty state) — Task 6.A moved it off the Dashboard. No SubscriptionsCard on the Dashboard anymore; the audit nudge is the summary strip on /subscriptions itself.
- Quick-Add FAB bottom-right (safe-area-bottom).
- **Simple-mode Dashboard** (when `user_stats.simple_mode = true`): the donut + budget alerts pair and the MonthProjection card are replaced by a single SimpleMonthCard — one big "£X left this month" headline plus a gradient progress bar against `user_stats.monthly_limit`. If the limit hasn't been set yet, the same slot renders an inline "Set your monthly limit" form rather than bouncing the user to Settings.

### Quick-Add flow (critical)

- Amount input auto-focuses on open.
- Expense/Income segmented control.
- Category chip grid — **tapping a chip auto-submits**. No separate submit button for the golden path.
- Hidden "Add a note or change the date" toggle for the rare case.
- **Merchant memory (Task 6.9):** typing in the note field (debounced 250ms) asks `GET /api/categories/suggest` and rings the suggested chip in emerald — history first, keyword map for first-time merchants. Highlight-only, never auto-selects; suggestion failures are silent.
- On success: invalidate `['dashboard', 'transactions', 'me']`, trigger appropriate confetti, show toast.
- **"Type it instead" path (Task 6.6):** a sparkle-chip toggle at the top of the dialog swaps the structured form for a single freeform textarea ("e.g. spent 12 quid on tacos last night"). Submitting calls `POST /api/transactions/parse`, which returns a draft. The dialog snaps back to the structured form with amount/type/description/date pre-filled and the suggested category chip ringed in emerald — the user still taps a chip to log. Parse never auto-saves. Failure / low confidence / API unavailable falls back to a friendly amber prompt ("couldn't quite read that — mind trying again?") with a "Use chips" escape hatch.
- **Simple-mode variant:** when `user_stats.simple_mode = true`, the Income/Expense segments, chip grid, and advanced toggle all hide; the dialog collapses to amount + a single "Log" button. The transaction is filed against the seeded "Other" expense category. This is the deliberate 2-tap exception to the otherwise-3-tap rule (FEATURES.md → philosophy → simple mode).

### Transactions

- Full log, searchable (category name + note).
- Filter by month, category, type (all/in/out).
- Inline edit dialog: amount, category, date, note.
- Row delete with confirm.
- CSV export of the currently-filtered set.

### Budgets

- CRUD. Card per budget with icon, limit, spent, progress bar, remaining.
- Progress colours: primary → amber-300 (≥75%) → amber-400 (≥90%) → rose-400 (over).
- Copy stays friendly even when over ("You've gone over — want to adjust next month?").
- Only expense categories; unique per (category, period).

### Analytics

- This-month / last-month / delta% header.
- 6-month income-vs-expenses line chart.
- Top 5 spending categories this month with mini bars.

### Savings Goals

- CRUD with emoji picker, name, target amount, optional target date.
- Contribute dialog adds money; server detects milestone crossings (25/50/75/100%) and returns a flag the client uses to celebrate.
- Progress bar + "£X to go" copy.

### Subscriptions

- Auto-detected list of recurring expenses, no manual marking required. Detection rule: ≥3 same-merchant charges at ~30-day or ~365-day intervals (±5d) with amounts within 10%.
- Each row shows monthly cost, annualised cost, last charged, next expected, and total paid lifetime.
- "Mark cancelled" toggle moves the row to a Cancelled section and surfaces the saved annual amount; toggling back to Active restores it. Decisions persist in `subscription_overrides` so a new month of detection doesn't overwrite them.
- Every active row gets a "Not a subscription" link that flips status to `dismissed` — separate from cancelled, no celebratory toast, excluded from the saved-money totals. (Originally inferred-rows-only; dogfooding showed described rows false-positive too — rent is a recurring charge but not a subscription.) Dismissed rows live in their own quiet section, restorable.
- Renaming is a compact affordance: unnamed inferred rows open the name form by default (naming them is the point); every other row gets a small "Rename" pencil button instead of a permanently-open input.
- No Dashboard mini-card anymore (Task 6.A) — the audit nudge is the summary strip at the top of /subscriptions.
- Empty state on the page itself when no subs are detected — friendly placeholder, never hides the nav link.
- **Known limitation (Task 6.2.1):** today's detector groups by transaction description text, so quick-logged transactions (no description, the 3-tap default) are invisible to it. Task 6.2.1 closes the gap with a `(category, amount-cluster, cadence)` fallback and inline naming on the audit page.

### Ask Trim (the marquee differentiator)

- **What it is:** a floating chatbot — Sparkles FAB pinned bottom-left on every authenticated page (mirrors the QuickAdd FAB on the right). Click to expand a glassmorphic chat panel anchored over the same corner; click X or press Escape to close. The widget (`client/src/components/AskChatbot.jsx`) is the only entry point — no `/ask` route. Mounted once at the `App` shell so it survives navigation between pages.
- **Voice:** the same FEATURES.md tone rules apply, with extra teeth — never shaming, never red, never tells the user they "can't afford" something. Frames trade-offs and lets the user decide.
- **Capabilities:** **answer-only for v1.** The chat does not create budgets, log transactions, adjust goals, or take any action — even if asked. If the user wants to act, the assistant points them at the right Trim page.
- **Context bundle:** assembled server-side by `server/lib/askContext.js` from the last 90 days of transactions, current budgets, savings goals + recent contributions, and `user_stats`. Pure function; same shape feeds prod and the eval script.
- **Streaming:** server returns SSE; client uses `fetch().body.getReader()` and dispatches `user_message` / `delta` / `done` / `error` events. Token-by-token updates show in a glassmorphic chat bubble while the response arrives.
- **History:** every turn persists to `ask_messages`. `GET /api/ask/history` (lazy-loaded on first open of the chatbot, not on every page mount) returns the latest 50 oldest-first for scrollback. "Clear" wipes the user's history via `DELETE /api/ask/history`.
- **Empty state:** four suggested prompts ("How much did I spend on food last month?" etc.) the user can tap to seed the conversation.
- **Safety:** the system prompt explicitly forbids revealing itself, sending data anywhere, and switching personas. Adversarial prompts ("ignore previous instructions", role-play overrides) are handled by the prompt, not by a separate filter layer.
- **Prompt cache:** the static rules block is marked `cache_control: ephemeral`. Within the 5-minute cache window, follow-up turns pay roughly 10% of input cost on the rules block — material when users ask 3–4 questions in a row.
- **Ship gate (`server/scripts/askEval.js`):** 20-question eval over five personas (standard, newbie, empty, goals-complete, heavy-spender) covering factual recall, forward-looking, edge cases, tone enforcement, and adversarial. Hybrid grading — substring checks for factual, Haiku-as-judge for everything else. Runs 3× to check variance. Reports latency p50/p95, average $-cost. Required to pass ≥85% AND meet latency/cost ceilings before shipping. Tone-variant comparison via `ASK_PROMPT_VARIANT=cold-open` env (default is `one-shot` with an example exchange anchored in the system prompt).

### Settings

- Currency picker (GBP / USD / AUD / VND / PLN) — display only, no FX conversion.
- Simple mode toggle. Flipping it on without a `monthly_limit` set hands the user off to the SimpleMonthCard's inline limit form on the Dashboard rather than bouncing them around.
- Display name.
- Manage categories (Task 6.11): rename, recolour, change icon, add new, delete with reassign-to-Other recovery flow. Default categories are personalisable but the seeded "Other" / "Other Income" are protected from deletion (they're the reassign safety net).

### Login / Signup

- RHF + zodResolver. Email + password. Signup min 8 chars, login min 6.
- Redirect to `/dashboard` once `session` is set.
- Email confirmation is **off** (since 2026-07-14, see SECURITY.md): signup returns a session immediately and lands on the Dashboard. The Signup page still handles the confirmation flow as a fallback — if `signUp` ever returns no session and no error (confirmation re-enabled, or an already-registered email, which Supabase anti-enumeration answers the same way), the form is replaced by a "Check your inbox" panel instead of doing nothing.

## Product features deferred (explicitly)

These were in the original vision but intentionally punted past MVP:

- **Weekly digest card** — Sunday summary with streak, XP, and a low-pressure tip.
- **Recurring transactions executor** — `is_recurring` column is on the schema but no cron/Edge Function processes them yet.
- **Profile / achievements page** — badges screen once badges are awarded.

## Planned — Trim Premium (designed 2026-07-15, not built)

Full design: `docs/superpowers/specs/2026-07-15-bank-sync-and-billing-design.md` · build tasks: BUILD_PLAN.md Phase 8.

- **Automatic bank import (open banking, UK first via Enable Banking).** Users connect their bank by authenticating *at the bank* (Trim never sees credentials); booked card purchases flow in automatically. Imported transactions land in a "New from your bank" review inbox on Transactions — one tap ✓ confirms, tapping another category chip recategorises + confirms (3-tap rule holds). The first review of the day counts as the daily "log" for streaks/XP; bulk imports never award XP. Single-currency rule enforced: accounts in another currency are politely refused (no FX). Vietnam (and other uncovered countries): friendly "not available yet" messaging, manual logging stays great.
- **Trim Premium billing (Stripe).** Freemium: manual logging + gamification free forever; bank sync becomes the premium feature at ~£3.99/mo (or £29/yr) via Stripe-hosted Checkout + Customer Portal — card details never touch Trim. During the current testing phase sync is free for everyone (`PREMIUM_ENFORCED=false`); flipping to paid is a config change.
- **Naming rule:** this is "billing / plan / premium" in code and copy — "Subscriptions" already means the recurring-merchant detection feature.

## Planned — Phase 9 (designed 2026-07-17, not built)

Full design: `docs/superpowers/specs/2026-07-17-pln-privacy-history-pace-special-design.md` · plan: `docs/superpowers/plans/2026-07-17-phase9-pln-privacy-history-pace-special.md` · build tasks: BUILD_PLAN.md Phase 9.

- **Special expenses (opt-in, off by default)** — a star flag for gifts/trips/one-offs: excluded from budget bars, pace, affordability, projections and wins, but still honest in hero cash flow, the transaction list and analytics, with a separate "Special this month" total. Settings toggle; flags go dormant when disabled.
- **Budget pace** — "by day N you'd typically have used £X of your budget" beside "Can I afford this?" (and in SimpleMonthCard vs `monthly_limit`). Amber when ahead of pace, never red.
- **Monthly history** — per-month Spent/Income/Net/Special table on Analytics (24 months), rows deep-link to Transactions filtered to that month.
- **Encryption at rest** — amounts, descriptions, notes, category/goal names, budget limits and Ask Trim chats encrypted (AES-256-GCM, per-user derived keys) so the operator can't casually read users' finances in Supabase. Honest limits documented in SECURITY.md when built.

## Design direction

- **Dark mode default**, light-mode toggle. Persisted to `localStorage['trim-theme']`. Applied inline before React mounts (no flash).
- **Accent: deep emerald.** Dark mode `--primary: 158 64% 52%`, light mode `158 64% 32%`. Conveys money + "trim/healthy".
- **Feel:** Linear / Notion × fitness app. Clean, minimal, modern. Big type. Generous spacing on desktop, tight on mobile.
- **Never a pure-red error state for user behaviour.** Destructive UI (delete confirms, failed requests) can use `text-destructive` sparingly; spending overshoots use rose-400 as a soft warning, not an error.
- **Dates render dd/mm/yyyy** (en-GB) everywhere an absolute date shows; recent activity keeps the friendlier relative labels (Today / Yesterday / N days ago) inside the last week. Helper: `formatDate` in `client/src/lib/format.js` — don't hand-roll date strings.
- **Favicon / app icon:** white scissors on the emerald gradient square — `client/public/favicon.svg` (browser tab) + `apple-touch-icon.png` (iOS home screen). Keep them in sync with the in-app logo mark.

### Visual language (ambient depth + motion)

Trim layers a quiet, breathing visual system on top of the design tokens to feel less templated and more crafted. Defaults — don't undo them without a reason:

- **Ambient mesh background.** `<div class="mesh-bg">` plus two large drifting `animate-blob` orbs sit fixed behind the app (`App.jsx`). Light/dark each have their own `--mesh-1/2/3` palette.
- **Glassmorphic chrome.** Sticky header and the dashboard hero use `.glass` + `backdrop-blur`. Cards default to `bg-card/70 backdrop-blur` with a hairline `border-border/60`.
- **Hover lift.** Cards use the `.lift` utility — 2px translate + soft primary-tinted shadow on hover. Pair with `bg-card/70 backdrop-blur` for the standard "interactive card" treatment.
- **Gradient + shimmer progress bars.** All progress fills (level XP, budgets, savings goals, top categories, budget alerts) use `bg-gradient-to-r` with the `.shimmer-bar` overlay so they look alive while still loading.
- **Tabular numerals.** Money values use the `.nums` utility (`font-variant-numeric: tabular-nums`) so digits don't dance during count-ups or filtering.
- **Gradient text.** The `.text-gradient` utility (emerald → gold) is reserved for the wordmark and the hero balance / "this month" totals — don't sprinkle it on body copy.
- **Motion vocabulary** (defined in `tailwind.config.js`):
  - `animate-flame` on the streak icon — gentle flicker.
  - `animate-blob` on background orbs — slow drift.
  - `animate-float-slow` on empty-state emojis (🌱 🎯 🧾 ✨) — they bob.
  - `animate-ring-pulse` on the FAB's outer ring — draws the eye without nagging.
  - `animate-fade-up` (with stagger via `style={{ animationDelay }}`) for hero/section reveal on dashboard load.
  - `.sheen-mask` runs a slow diagonal sheen across the hero card.
  - All motion is suppressed under `prefers-reduced-motion: reduce`.
- **Hero balance card.** The Dashboard opens with a single wide gradient-bordered card that animates the net balance up from 0 (`useCountUp` in `Dashboard.jsx`). In/Out chips sit alongside; the small Streak / Shields / Logs cards moved underneath. Avoid going back to a 3-up uniform stat grid — it's the main thing that made the page feel AI-templated.
- **Quick-Add category chips** lift on hover and reveal a soft glow in the category's own color so the grid feels alive even before tapping.

## Money model

- **Single currency per user** (GBP / USD / AUD / VND / PLN), stored on `user_stats.currency`.
- **No FX** — switching currency only changes display units (locale + symbol).
- Server validates `amount` as positive, finite, ≤ 1,000,000,000.

## How a future session should apply this

- Every new feature / component / copy string goes through the three-tap, celebrate-loudly-fail-quietly, playful-tone filter.
- Streak/XP/shield values live in one file (`server/lib/gamification.js`). Don't duplicate.
- Always read currency from `preferences`; never hardcode.
- If unsure about a new architectural choice (styling, libraries, schema), ask the user before picking a default.
