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

- Balance stat card (this month income − expenses) with sub-line "£X in · £Y out".
- Streak stat card with flame icon; sub shows shields banked or longest streak.
- Shields stat card (desktop only).
- Level card with XP progress bar and title ladder.
- Month-end projection card (above CategoryDonut) — linear extrapolation of current-month spend, delta vs. summed monthly budgets, one-line pace label vs. last month. Cold-start guard until day 3 with ≥1 transaction. Hidden in simple_mode (Task 6.5 owns its own equivalent).
- Category donut chart (expense breakdown) + budget alerts list (categories ≥75% used).
- Recent 5 transactions.
- Wins feed card (scrollable, latest 10) — derived from `GET /api/wins`. Surfaces under-budget weeks, streak milestones, banked shields, and savings contributions with before/after %. Playful empty state.
- Quick-Add FAB bottom-right (safe-area-bottom).

### Quick-Add flow (critical)

- Amount input auto-focuses on open.
- Expense/Income segmented control.
- Category chip grid — **tapping a chip auto-submits**. No separate submit button for the golden path.
- Hidden "Add a note or change the date" toggle for the rare case.
- On success: invalidate `['dashboard', 'transactions', 'me']`, trigger appropriate confetti, show toast.

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
- Dashboard mini-card above CategoryDonut nudges the user to audit ("You have N subscriptions, £X/month — audit them?"). Hidden when there are 0 active subs.
- Empty state on the page itself when no subs are detected — friendly placeholder, never hides the nav link.
- **Known limitation (Task 6.2.1):** today's detector groups by transaction description text, so quick-logged transactions (no description, the 3-tap default) are invisible to it. Task 6.2.1 closes the gap with a `(category, amount-cluster, cadence)` fallback and inline naming on the audit page.

### Settings

- Currency picker (GBP / USD / AUD / VND) — display only, no FX conversion.
- Simple mode toggle.
- Display name.
- Manage custom categories (future nice-to-have).

### Login / Signup

- RHF + zodResolver. Email + password. Signup min 8 chars, login min 6.
- Redirect to `/dashboard` once `session` is set.

## Product features deferred (explicitly)

These were in the original vision but intentionally punted past MVP:

- **Weekly digest card** — Sunday summary with streak, XP, and a low-pressure tip.
- **Recurring transactions executor** — `is_recurring` column is on the schema but no cron/Edge Function processes them yet.
- **Profile / achievements page** — badges screen once badges are awarded.

## Design direction

- **Dark mode default**, light-mode toggle. Persisted to `localStorage['trim-theme']`. Applied inline before React mounts (no flash).
- **Accent: deep emerald.** Dark mode `--primary: 158 64% 52%`, light mode `158 64% 32%`. Conveys money + "trim/healthy".
- **Feel:** Linear / Notion × fitness app. Clean, minimal, modern. Big type. Generous spacing on desktop, tight on mobile.
- **Never a pure-red error state for user behaviour.** Destructive UI (delete confirms, failed requests) can use `text-destructive` sparingly; spending overshoots use rose-400 as a soft warning, not an error.

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

- **Single currency per user,** stored on `user_stats.currency`.
- **No FX** — switching currency only changes display units (locale + symbol).
- Server validates `amount` as positive, finite, ≤ 1,000,000,000.

## How a future session should apply this

- Every new feature / component / copy string goes through the three-tap, celebrate-loudly-fail-quietly, playful-tone filter.
- Streak/XP/shield values live in one file (`server/lib/gamification.js`). Don't duplicate.
- Always read currency from `preferences`; never hardcode.
- If unsure about a new architectural choice (styling, libraries, schema), ask the user before picking a default.
