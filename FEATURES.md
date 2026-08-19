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
- **Budget pace (Task 9.3, extended in Phase 10 A4):** a one-line reading rendered by the shared `client/src/components/PaceLine.jsx` — used by both "Can I afford this?" (normal mode) and SimpleMonthCard (simple mode); the JSX used to be duplicated byte-for-byte in the two. Comes from `GET /api/projections/month`'s `pace` field — plain arithmetic (`budget × day-of-month ÷ days-in-month`), valid from day 1 unlike the month-end projection's cold-start guard. Three states:
  - **under pace** — "✓ By day 8, about £310 of your budget would typically be used — you're at £240, £70 under. That's £40/day for the 24 days left."
  - **over pace, under budget** — same shape, amber, "…£126 over where you'd normally be."
  - **over budget** — "◷ You're £155 over your £900 budget — nothing left for the last 24 days." `perDayLeft` is floored at 0 server-side; a negative daily allowance is meaningless, so the line reports `overBy` instead.
  Amber when running ahead of pace or over budget, emerald (`text-primary`) when under — never red/rose, never scolding. `pace` is `null` (line hidden) when there's no budget at all. Fields: `target, spent, delta, budget, daysRemaining, perDayLeft, overBy`.
- **Overall monthly budget (Phase 10 A5):** one ceiling that every expense category counts toward — set it on /budgets, not per category. Backed by the existing `user_stats.monthly_limit` (migration 008); Phase 10 simply stopped gating it behind `simple_mode`, so **no migration was needed**. When set it **is** the total: pace and "Can I afford this?" measure all expense spend against it, instead of summing the category limits. Category budgets remain as sub-limits underneath. Replaces the workaround of creating a category literally named "All Expenses", which silently double-counted (a £1200 umbrella plus Food £300 read as a £1500 total).
- "This month by category" card (Task 6.A merged the old donut + budget-alerts pair): donut + top-5 list + a "Budgets to watch" column of categories ≥75% used, one card. Hidden in simple_mode (replaced by the SimpleMonthCard).
- Recent 5 transactions + a 3-entry "Recent wins" peek side-by-side (lg). The peek links to /wins, which hosts the full feed (latest 10, playful empty state) — Task 6.A moved it off the Dashboard. No SubscriptionsCard on the Dashboard anymore; the audit nudge is the summary strip on /subscriptions itself.
- Quick-Add FAB bottom-right (safe-area-bottom).
- **Simple-mode Dashboard** (when `user_stats.simple_mode = true`): the donut + budget alerts pair and the MonthProjection card are replaced by a single SimpleMonthCard — one big "£X left this month" headline plus a gradient progress bar against `user_stats.monthly_limit`. If the limit hasn't been set yet, the same slot renders an inline "Set your monthly limit" form rather than bouncing the user to Settings.
- **Special expenses chip (opt-in, Task 9.2):** when `user_stats.special_expenses_enabled` is on and there's at least one flagged expense this month, a third amber "Special" chip appears beside the In/Out chips in the hero, showing `month.specialThisMonth` — flagged gifts/trips/one-offs, honestly still counted in hero cash-flow but excluded from the by-category card and budget alerts below it. Dormant when the pref is off: no chip, exclusions stop applying.
- **Special-expense groups (Phase 10 B1):** a collapsible "Special expenses" panel listing each group with its **lifetime** running total (a Paris trip is paid across months — a total that reset on the 1st would answer the wrong question), tapping through to `/transactions?specialGroup=<id>`. Rendered only when the special-expenses pref is on. A closing line states the month's special spend and notes the group totals are lifetime, so the two figures are never silently mistaken for each other.
- **Special in/out toggle (Phase 10 A6):** a small "incl. special / excl. special" chip next to "Net this month" flips the hero's Out figure and net between counting special expenses and leaving them out, so Alex can see his month with and without the one-offs. Purely client-side — `/api/dashboard` already returns `expenses` *including* special plus `specialThisMonth`, so excluding is `expenses − specialThisMonth` exactly. Persisted in `localStorage` under `trim:heroIncludeSpecial`. Rendered only when the pref is on **and** `specialThisMonth > 0`; while excluding, the Special chip relabels to "Special (out)" so the difference is always explained.

### Dates

A calendar day belongs to the user, not the server. Every "today" in the client comes from
`todayISO()` in `client/src/lib/format.js`, which is built from LOCAL date parts. It used to be
`new Date().toISOString().slice(0,10)` — the UTC day — so anything logged between local midnight
and UTC midnight was stamped yesterday and rendered as "Yesterday" the moment it was logged; on the
1st of a month it landed in the previous month for the dashboard, budgets and the running average.
A create also sends `clientToday` purely so the streak follows the user's day, kept separate from
`date` so backfilling last month cannot count as logging today.

The **server** side is fixed too (Phase 14). `user_stats.timezone` holds the user's IANA zone,
reported automatically by the client whenever it differs from what is stored — no setting to find,
and none to get wrong mid-trip. Every period boundary now comes from `server/lib/month.js`, one
pure tz-aware definition that replaced three copies of `monthBounds` and a dozen ad-hoc
`getUTCMonth()` calls across dashboard, budgets, affordability, projections, analytics, wins and
ask. A NULL zone falls back to UTC, which is exactly the old behaviour, and an unresolvable zone
fails open to UTC rather than erroring.

### Cache invalidation

Everything derived from money is refreshed through `invalidateMoney()` in
`client/src/lib/invalidate.js`. Deliberately blunt — an unnecessary refetch costs far less than two
screens disagreeing, which has happened here more than once. Do not hand-list keys in a mutation;
they drift.

### Foreign-currency expenses (Phase 12)

An expense can be entered in another currency and is converted at entry into **the user's own
default currency** (`user_stats.currency` — never a hard-coded GBP). `transactions.amount` therefore
stays single-currency exactly as before, which is why no total, budget, average, projection or
affordability check needed changing. The original amount, its currency and the rate used are stored
alongside purely for display and audit; all three are NULL for an ordinary same-currency row.

- A quiet currency chip sits beside the Amount field in Quick Add, defaulting to the user's own
  currency, so the two-tap path is unchanged for anyone not travelling.
- Rates come from `GET /api/fx` (Frankfurter / ECB daily, free, no API key), cached per day.
- **The rate is always editable**, and manual entry is a first-class path, not just a fallback:
  Frankfurter covers 30 currencies and does **not** include VND, which is one of Trim's five base
  currencies. An unquotable pair returns `rate: null` and asks the user to type the rate.
- **The server derives the stored amount** from original × rate and ignores whatever `amount` the
  client sent — one figure, one place. See `server/lib/fx.js`.
- Rounding follows the *base* currency, so a VND-based user never ends up holding 38.50 dong.
- **Editing can change the currency** (Phase 12b). The edit dialog seeds from the row's own
  currency and the rate it was created at, only re-fetching if you actually change currency —
  opening a row must never silently re-rate it at today's price. Clearing back to your own
  currency converts it to a plain row.
- **A foreign entry cannot be saved without a usable rate.** The category chips and the simple-mode
  Log button stay disabled until the rate is valid, with a helper line naming the pair. Without
  that gate the amount field holds the FOREIGN number while the currency block is dropped, and the
  server — which cannot know the entry currency — stored it verbatim as base currency.

### Quick-Add flow (critical)

- Amount input auto-focuses on open.
- Expense/Income segmented control.
- Category chip grid — **tapping a chip twice submits** (Phase 10 A2). The first tap *arms* the chip: it fills solid and its label swaps to "Tap again", with the helper line reading "Tap Food again to log it — or pick a different one." The second tap on that **same** chip logs. Tapping a different chip just moves the arm, so a misdirected thumb never files an expense to the wrong category. Disarms on: amount edit, Expense/Income switch, dialog close, successful log. Editing the note does **not** disarm — people often type the note after choosing. `aria-pressed` marks the armed chip.
- **Note field is always visible** (Phase 10 A2) — it sits between Amount and the category grid, no longer hidden behind a disclosure. It has to come before the grid because it drives the merchant-memory suggestion that rings a chip in that grid.
- Remaining disclosure holds Date, the special-expense toggle, and the recurring opt-in.
- **Recurring opt-in (Task 6.12b):** a "Repeat this — logs itself from now on" checkbox in the advanced area, **expense-only** (the server 400s `Only expenses can be recurring`). Ticking it reveals Monthly / Weekly pills. Sends `recurring: { interval }` on POST; the response carries the new `recurrence`, and the toast reads "Repeating monthly 🔁 · Manage it on Subscriptions." Invisible in simple mode, like every other advanced field.
- **Merchant memory (Task 6.9):** typing in the note field (debounced 250ms) asks `GET /api/categories/suggest` and rings the suggested chip in emerald — history first, keyword map for first-time merchants. Highlight-only, never auto-selects; suggestion failures are silent.
  - **Changing under Phase 9.5 (built, not yet live).** Once descriptions are encrypted, the database
    can no longer run `.ilike('%term%')` on them. The lookup becomes a blind index over the first 2–8
    characters of the normalised merchant, refined exactly on the server. Typing still lights the chip
    from the second character, case and branch numbers are still ignored, and apostrophe merchants
    ("Sainsbury's") start matching for the first time. **Mid-word ("esco" → Tesco) and later-word
    ("Express" → Tesco Express) matching still work**: the blind index answers the fast prefix case,
    and `server/lib/merchantMemory.js` falls back to scanning and decrypting recent history for
    anything the index cannot express. The one deviation is that the fallback looks at the most
    recent 500 transactions rather than all of them.
- On success: invalidate `['dashboard', 'transactions', 'me']`, trigger appropriate confetti, show toast.
- **"Type it instead" path (Task 6.6):** a sparkle-chip toggle at the top of the dialog swaps the structured form for a single freeform textarea ("e.g. spent 12 quid on tacos last night"). Submitting calls `POST /api/transactions/parse`, which returns a draft. The dialog snaps back to the structured form with amount/type/description/date pre-filled and the suggested category chip ringed in emerald — the user still taps a chip to log. Parse never auto-saves. Failure / low confidence / API unavailable falls back to a friendly amber prompt ("couldn't quite read that — mind trying again?") with a "Use chips" escape hatch.
- **Simple-mode variant:** when `user_stats.simple_mode = true`, the Income/Expense segments, chip grid, and advanced toggle all hide; the dialog collapses to amount + a single "Log" button. The transaction is filed against the seeded "Other" expense category. This is the deliberate 2-tap exception to the otherwise-3-tap rule (FEATURES.md → philosophy → simple mode).
- **Special expense toggle (opt-in, Task 9.2):** when the Settings pref is on, a starred "Special expense" checkbox appears inside the hidden advanced area — expenses only, off by default per log. Flagging it excludes the transaction from budget math; the success toast reads "Logged as special ⭐" instead of the usual XP toast. Invisible whenever the pref is off, so the 3-tap path never grows a step.

### Transactions

- Full log, searchable (category name + note).
- Filter by month, category, type (all/in/out).
- Inline edit dialog: amount, category, date, note.
- Row delete with confirm.
- CSV export of the currently-filtered set.
- **Special groups (Phase 10 B1):** the edit dialog carries the same optional group picker as Quick-Add, and a clearable amber chip appears when the page is deep-linked from the Dashboard panel via `?specialGroup=`.
- **Recurring (Task 6.12b):** rows carrying `is_recurring` show a "Recurring" pill on the meta line, and a "Recurring" filter chip sits beside the Special one. Both read fields already on `GET /api/transactions` — no server change.
- **Special expenses (opt-in, Task 9.2):** when the pref is on, each expense row gets a one-tap star/unstar ghost button next to Edit — retroactively including or excluding a transaction from budget math without opening the edit dialog — plus a small star marker beside starred amounts and a "Special" filter chip alongside the type filter. The edit dialog carries the same checkbox. All of this is invisible when the pref is off.

### Budgets

- **Overall monthly budget card pinned at the top (Phase 10 A5)** — one ceiling covering every expense category, showing "£X left", spent-of-limit, and the same progress-tone bar. Set / edit / clear inline; saves through `PATCH /api/me { monthlyLimit }` (null clears). Empty state: "Set one ceiling for everything". Category budgets below it are sub-limits inside it.
- CRUD. Card per budget with icon, limit, spent, progress bar, remaining.
- Progress colours: primary → amber-300 (≥75%) → amber-400 (≥90%) → rose-400 (over).
- Copy stays friendly even when over ("You've gone over — want to adjust next month?").
- Only expense categories; unique per (category, period).

### Analytics

- **Average month (Phase 11):** the top card. Shows what a normal month costs, over the last 3, 6 or 12 **completed** months — the month in progress is deliberately never averaged in, because a part-month drags the mean down and makes the figure creep upward all month. It is shown alongside instead, as "this month so far". The switch defaults to 6 months and remembers the choice in `localStorage` under `trim:avgWindow`. All three windows arrive in one `/api/analytics` response, so switching never refetches. When history is shorter than the window the card says so honestly — "last 8 completed" for a 12m window with 8 months of data — rather than dividing by 12.
  - **incl. / excl. special toggle**, styled and behaving like the Dashboard hero's, and appearing only when there is special spend in the selected window. Its memory (`trim:avgIncludeSpecial`) is deliberately **separate** from the hero's `trim:heroIncludeSpecial`: the hero toggles this month's net, this toggles an N-month expense average, so flipping one must not silently change the other page. Toggling also switches "this month so far" to the matching basis, so the two figures are always like for like.
  - **Empty-month prompt.** A month inside the window with nothing logged counts as £0 — it may be a genuinely cheap month — but that could equally be a month Alex forgot to log, which would quietly flatter the average. So the card names them ("3 months with nothing logged (Feb, Mar, Apr)") and the prompt is a button: it opens Quick Add pre-dated to the 1st of the most recent gap month, with the date field revealed **even in simple mode**, which otherwise hides it. Leading pre-signup months are trimmed first (the same rule Monthly history uses), so they are never reported as gaps.
  - The rule lives in `server/lib/runningAverage.js` — one pure, tested definition, for the same reason `overallBudget.js` exists. 12 unit tests in `server/test/runningAverage.test.js`. Mirrored into `scripts/devMock.js` so the card is visible under `npm run dev:mock`.
- This-month / last-month / delta% header.
- 6-month income-vs-expenses line chart.
- Top 5 spending categories this month with mini bars.
- **Monthly history (Task 9.4):** a full history table below the chart, fetched as 24 months of data (the chart still only plots the last 6). One row per month, newest first — Spent, Income, Net, and (when `user_stats.special_expenses_enabled` is on and at least one month has flagged special spend) a Special column with a star marker. Months before the user's first transaction are trimmed from the list; the current month is labelled "so far". Tapping a row opens `/transactions?month=YYYY-MM`, which deep-links Transactions straight to that month, fetching it directly from the API rather than relying on the page's default 200-row recent window.

### Savings Goals

- CRUD with emoji picker (the full Phase 10 A3 picker — see Settings → Categories), name, target amount, optional target date.
- Contribute dialog adds money; server detects milestone crossings (25/50/75/100%) and returns a flag the client uses to celebrate.
- Progress bar + "£X to go" copy.

### Subscriptions

- **Manually-marked recurrences (Task 6.12b)** appear alongside detected ones, carrying `source: 'manual'` and a "Manually marked" pill. They deliberately expose a *different* action set, because the server rejects two of the detected-row actions for them: **no Rename** (`manualPatchSchema` has no `displayName`) and **no "Not a subscription"** (dismiss returns 400 — the user opted in deliberately, so cancel is the off-ramp). In exchange they get an **amount edit**, which applies to future charges only; transactions already logged keep the amount they were logged with and are never rewritten.
- Cadence labels are a three-way map (`lib/subscriptions.js`): Annual / Monthly / **Weekly**. Before 6.12b everything non-annual was labelled "Monthly", which mislabelled every weekly manual recurrence.

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
- **Special expenses toggle (opt-in, Task 9.2):** off by default. "Track gifts, trips and one-offs outside your monthly budget. Off by default — flip it on and a star appears in Quick-Add." Turning it off makes every past and future special flag dormant — server math and client UI both go back to treating every transaction as normal.
- Manage categories (Task 6.11): rename, recolour, change icon, add new, delete with reassign-to-Other recovery flow. Default categories are personalisable but the seeded "Other" / "Other Income" are protected from deletion (they're the reassign safety net).
- **Any-emoji icon picker (Phase 10 A3):** the old fixed 20-emoji palette is now just a one-tap shortcut row. Below it sits `client/src/components/EmojiPicker.jsx` — a "paste any emoji" field (on a phone, that's the emoji keyboard, which covers skin tones and everything not in the catalogue) plus a collapsed "Browse all emoji" panel with search and nine group tabs over ~1,135 emoji. No npm dependency; the catalogue (`client/src/lib/emojiData.js`) is dynamically imported so it's a separate ~26KB chunk that only loads when the browser is opened. Collapsed by default so the dialog still fits a phone screen with its Save button.
  - Validation moved from `z.string().max(8)` to **exactly one pictographic grapheme** (`server/lib/emoji.js`, mirrored client-side). The old UTF-16 bound rejected legitimate emoji — 👨‍👩‍👧‍👦 is 11 code units — while accepting `"hack"` and `"🍔🍔🍔🍔"`. The check also allows flags (regional-indicator pairs) and keycaps (`1️⃣`), neither of which is `Extended_Pictographic`. Same rule now applies to savings-goal emoji.

### Login / Signup

- RHF + zodResolver. Email + password. Signup min 8 chars, login min 6.
- Redirect to `/dashboard` once `session` is set.
- **The 12 default categories** are seeded on signup by the `handle_new_user()` database trigger.
  Under Phase 9.5 (built, not yet live) migration **018a** takes category seeding out of that
  trigger — the database holds no encryption key, so it cannot write `categories.name_enc` — and
  `GET /api/me` and `GET /api/categories` seed them instead
  (`server/lib/defaultCategories.js`). Both routes, because the client starts them independently and
  either may return first. It is idempotent, so it is already deployed-safe and does nothing while
  the trigger is still doing the job.
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

- **Encryption at rest** — amounts, descriptions, notes, category/goal names, budget limits and Ask Trim chats encrypted (AES-256-GCM, per-user derived keys) so the operator can't casually read users' finances in Supabase. Honest limits documented in SECURITY.md when built.

## Dialog behaviour (shared, `client/src/components/ui/dialog.jsx`)

Every dialog is capped at `max-h-[92dvh]` with its **content** scrolling inside and the close (X)
button pinned to the dialog rather than the scroll area — so a tall dialog can always be both
completed and dismissed.

This was a real bug found on 2026-08-08: `DialogContent` is `position: fixed` with no height cap,
so any dialog taller than the viewport grew off the top *and* bottom with nothing scrollable and no
reachable buttons. Only QuickAddDialog had worked around it locally (`max-h-[94vh] overflow-y-auto`);
the category, reassign, budget, both savings and transaction-edit dialogs were all affected — the
emoji picker simply made two of them tall enough to expose it. Fixed once in the shared component.

`dvh` rather than `vh` deliberately: mobile Safari's `vh` counts the area behind the browser chrome,
which would put the footer buttons under the URL bar.

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
- **All money is entered through `client/src/components/ui/money-input.jsx`** (Phase 10 A1) — `type="text"` + `inputMode="decimal"` with our own sanitiser, never `type="number"`. A number input reports `''` from `.value` for any string that isn't yet a complete number, so a controlled React field silently ate the decimal point the moment it was typed, and rejected a comma outright. That made decimals **impossible on a phone in a comma-decimal locale** — which is exactly Alex's, since PLN formats as `pl-PL`. The sanitiser accepts digits and one separator, normalises `,` → `.`, keeps the `"12."` intermediate state alive, and clamps to 2 decimal places (0 for VND, which `formatMoney` renders without minor units). All seven money fields use it.
- **What "your total budget" means lives in one place**, `server/lib/overallBudget.js` (Phase 10 A5). An overall budget, when set, *is* the total and every category counts toward it; with none set it falls back to the sum of the monthly category budgets measured against budgeted-category spend only. `projections.js`, `affordability.js` and `budgets.js` all read from it — previously each answered independently and two of them disagreed on the same Dashboard screen.
- **Special-expense groups never touch budget math.** Groups are a label on spending that is already excluded from budgets via `server/lib/special.js`. Deleting a group is `on delete set null` — the spending survives, ungrouped. Un-starring a transaction clears its group (and drops it from that group's total) rather than being rejected.
- **Special expenses are opt-in and dormant when off** (`user_stats.special_expenses_enabled`, `transactions.is_special`) — when enabled, flagged expenses are excluded from budget bars, projections, affordability and wins math, but always counted in hero cash-flow, the transaction list and analytics (which get their own `special` bucket). The exclusion logic lives in one place, `server/lib/special.js`.

## How a future session should apply this

- Every new feature / component / copy string goes through the three-tap, celebrate-loudly-fail-quietly, playful-tone filter.
- Streak/XP/shield values live in one file (`server/lib/gamification.js`). Don't duplicate.
- Always read currency from `preferences`; never hardcode.
- If unsure about a new architectural choice (styling, libraries, schema), ask the user before picking a default.
