# Product

## Register

product

## Platform

web

## Users

One primary user today: Alex, tracking his own daily spending on his phone (mobile-first) and laptop. Next ring: his friends and family, invited by URL — mixed technical ability, zero tolerance for setup friction. Possible future ring: paying strangers, if the app proves sticky. All of them are *in a task* when they open Trim: "log what I just spent" (dozens of seconds, often standing in a shop) or "how am I doing this month?" (a 30-second glance).

## Product Purpose

A budget tracker that makes money management feel like Duolingo, not a bank app. Manual, intentional expense logging (3 taps), gamified consistency (streaks, XP, shields), and forward-looking answers (month-end projection, "can I afford this?", Ask Trim chat grounded in the user's own data). Success = the user opens it every day without dread, and can name one thing it saved them (a trimmed subscription, an avoided overspend).

## Brand Personality

Warm coach, never accountant. Three words: **encouraging, playful, calm**. Celebrates loudly (confetti, level-ups, wins feed), fails quietly (amber/rose nudges, "want to adjust next month?"). Never shames, never moralises, never says "you can't afford it" — it frames trade-offs and lets the user decide.

## Anti-references

- **Bank apps and Mint-era dashboards**: dense tables, red warnings, guilt-driven "you overspent!" alerts.
- **Punitive budget apps**: anything where opening the app feels like being told off.
- **Generic AI-built SaaS**: interchangeable stat-card grids, purple-gradient hero clichés, template sameness. Trim's committed look (deep emerald, dark-first, ambient mesh, glass chrome) is the identity — don't dilute it toward "safe".
- **Feature-buffet finance suites** (net worth, crypto, insurance…): Trim stays deliberately small; simplicity is a feature.

## Design Principles

1. **Dopamine > guilt** — every interaction leans toward positive reinforcement; overspend is a soft rose nudge, never an error state.
2. **Three taps or it's too many** — the golden logging path is amount → category → done; anything extra is progressive disclosure.
3. **Forward-looking beats backward-looking** — projections, affordability checks, and grounded answers move behaviour; charts of the past alone don't.
4. **Celebrate loudly, fail quietly** — confetti and toasts for wins; calm copy and gentle colour for slips.
5. **Simple mode is sacred** — the one-number experience must always work; new features hide in simple mode by default.

## Accessibility & Inclusion

- All motion suppressed under `prefers-reduced-motion` (already enforced in `client/src/index.css`).
- Dark mode default with a maintained light theme; both must keep body text ≥4.5:1 (light-mode `--gold` was already darkened for this).
- Touch targets ≥44px on mobile; the app must be fully usable one-handed on a 375px phone.
- Currency display respects the user's choice (GBP/USD/AUD/VND); never hardcode symbols.
