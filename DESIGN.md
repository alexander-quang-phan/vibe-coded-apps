# Design

Visual system captured from live code (`client/src/index.css`, `client/tailwind.config.js`, FEATURES.md → Design direction). Tokens are HSL triplets consumed as `hsl(var(--token) / alpha)` by Tailwind.

## Theme

Dark-mode **default** (`<html class="dark">`, persisted in `localStorage['trim-theme']`, applied pre-mount to avoid flash); light mode is the toggle. Feel: Linear/Notion × fitness app — clean, modern, big type, generous desktop spacing, tight mobile spacing. An ambient layer keeps it from feeling templated: fixed mesh-gradient background with two slow-drifting blurred orbs, glass chrome, shimmer on progress fills.

## Color

| Token | Dark | Light | Role |
|---|---|---|---|
| `--background` | `222 30% 7%` | `150 30% 98%` | page |
| `--card` | `222 30% 10%` | `0 0% 100%` | surfaces (usually `bg-card/70 backdrop-blur`) |
| `--foreground` | `210 40% 98%` | `222 47% 11%` | ink |
| `--muted-foreground` | `215 18% 68%` | `215 16% 47%` | secondary text |
| `--primary` | `158 64% 52%` | `158 64% 32%` | deep emerald — actions, selection, wins |
| `--accent` | `158 40% 18%` | `158 60% 94%` | hover/selected fills |
| `--gold` | `42 95% 60%` | `42 90% 40%` | gradient-text tail, celebratory accents (light value darkened for ≥3:1) |
| `--warning` | `38 92% 55%` | `38 92% 50%` | budget ≥75% |
| `--destructive` | `0 65% 45%` | `0 80% 55%` | delete/failed requests ONLY |
| `--border` / `--input` | `215 20% 18%` | `214 32% 91%` | hairlines (`border-border/60`) |
| `--mesh-1/2/3` | emerald/blue/purple mids | pastel emerald/blue/gold | ambient mesh blobs |

Rules:
- **Never pure red for user behaviour.** Overspend = `rose-400` as a soft warning; `--destructive` is reserved for destructive UI.
- Accent = emerald, used for primary actions, active states, positive numbers — not decoration.
- Category colors come from the DB per category (user-editable hex); use them for chips, donut slices, row accents at low alpha (`${color}22` backgrounds).
- Semantic progress tones: emerald→primary (fine), amber-300→500 (≥75–90%), rose-400→500 (over).

## Typography

System sans stack (Tailwind default) with `font-feature-settings: 'cv11','ss01','ss03'` and antialiasing. One family everywhere; hierarchy by size/weight only.

- Page titles: `text-3xl sm:text-4xl font-extrabold tracking-tight` with a one-line muted kicker sentence above.
- Hero balance: `text-5xl sm:text-6xl font-extrabold` + `.text-gradient`.
- Card headers: `text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground`.
- **Money always uses `.nums`** (`font-variant-numeric: tabular-nums`) so digits don't dance during count-ups.
- `.text-gradient` (emerald→gold) is reserved for the wordmark, hero balance, and simple-mode headline. Nowhere else.

## Spacing, Radius, Layout

- Radius token `--radius: 0.95rem`; cards render `rounded-2xl`, chips/buttons `rounded-xl`/`rounded-full`.
- Page rhythm: `space-y-5`/`space-y-6`; card padding `p-5`/`p-6`.
- Shell: sticky `.glass` header (desktop center nav, mobile horizontal pill nav with ≥44px targets), `container px-4` main, two FABs — Ask Trim bottom-left, QuickAdd "+" bottom-right, both `safe-bottom`.
- Dashboard order: hero balance → affordability check → 3-stat row → level card → projection → category card (donut | top-5 | budgets-to-watch) → recent activity + wins peek. Simple mode swaps projection/affordability/category for one SimpleMonthCard. Never regress to a uniform 3-up stat grid — that's the AI-template look this app deliberately avoids.

## Components

- **Card**: `lift border-border/60 bg-card/70 backdrop-blur`, optional blurred color orb in a corner (`blur-3xl` circle at low alpha).
- **Progress fills**: `bg-gradient-to-r` + `.shimmer-bar` overlay, `h-1`–`h-2.5`.
- **Chips** (categories): emoji + name, `rounded-xl border`, category-color glow on hover; suggested chip gets `ring-2 ring-primary/60`.
- **FABs**: 56–64px gradient circles (`from-primary to-emerald-700`) with `animate-ring-pulse` halo.
- **Dialogs**: Radix + shadcn styling; auto-focused amount input; chip tap auto-submits.
- **Empty states**: floating emoji (`animate-float-slow`) + friendly two-line copy; never hide an empty card.
- **Toasts**: sonner; success on log ("+10 XP"), celebration variants trigger canvas-confetti (level-up, shield, streak milestone, goal milestone).

## Motion

Vocabulary lives in `tailwind.config.js`: `animate-flame` (streak icon flicker), `animate-blob` (bg orbs), `animate-float-slow` (empty-state emoji), `animate-ring-pulse` (FAB halo), `animate-fade-up` (staggered section reveal via `animationDelay`), `.sheen-mask` (hero sheen), `.shimmer-bar` (progress). Easing `cubic-bezier(0.22,1,0.36,1)`, 150–300ms for state changes. **Everything is disabled under `prefers-reduced-motion: reduce`** — keep new animations in that block.
