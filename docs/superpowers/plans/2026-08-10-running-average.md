# Running Average of Monthly Expenses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Analytics card showing the average monthly expense over the last 3, 6 or 12 *completed* months, with an incl./excl. special-expenses toggle and a prompt to backfill any month with nothing logged.

**Architecture:** A pure server lib (`runningAverage.js`) owns the definition of "an average month" and is called three times — once per window — inside the existing `/api/analytics` handler, which already has every transaction it needs in memory. The response gains one additive `average` field. A presentational card renders it; the Analytics page owns the Quick Add dialog that the card's "nothing logged" prompt opens.

**Tech Stack:** Node 20 + Express + `node:test` (server); React 18 + Vite + TanStack Query + Tailwind + shadcn/ui (client).

**Spec:** `docs/superpowers/specs/2026-08-10-running-average-design.md`

## Global Constraints

- **No database change, no migration, no new Supabase query.** Everything is derived from the transactions `/api/analytics` already fetches.
- **The `average` field is purely additive.** No existing key in the `/api/analytics` response may change shape.
- **Averages cover completed months only.** The month in progress is never mixed into a mean.
- **Money is rendered only through `formatMoney(amount, currency)`** from `@/lib/format` — never hand-formatted.
- **Every `localStorage` access is wrapped in try/catch**, matching `readIncludeSpecial()` in `client/src/pages/Dashboard.jsx:91`. Private browsing must never throw.
- **Rounding is `Number(x.toFixed(2))`**, matching `server/routes/analytics.js:84-87`.
- **Special expenses are already gated server-side.** `series[].special` is 0 whenever the user's preference is off (`analytics.js:76`). No new preference check is needed anywhere.
- Definition of done per `CLAUDE.md`: `npm test` passes in `server/`, `npm run build` passes in `client/`, the feature is reachable in the running UI, and `FEATURES.md` + `BUILD_PLAN.md` are updated in the same session.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `server/lib/runningAverage.js` | The one definition of "an average month". Pure, no I/O, no clock. |
| **Create** `server/test/runningAverage.test.js` | 12 unit tests for the above. |
| **Modify** `server/routes/analytics.js` | Call the lib three times, add `average` to the response. |
| **Modify** `client/src/components/QuickAddDialog.jsx` | New `initialDate` prop; reveal the date when pre-dated; invalidate `analytics` on success. |
| **Create** `client/src/components/AverageMonthCard.jsx` | Presentational card: figure, window switch, special toggle, empty-month prompt. |
| **Modify** `client/src/pages/Analytics.jsx` | Mount the card, own the backdating dialog's state. |
| **Modify** `FEATURES.md`, `BUILD_PLAN.md`, `CHAT_HANDOFF.md` | Documentation and baton. |

---

### Task 1: The running-average lib

**Files:**
- Create: `server/lib/runningAverage.js`
- Test: `server/test/runningAverage.test.js`

**Interfaces:**
- Consumes: nothing — this is the first task.
- Produces: `buildRunningAverage({ series, months, currentYm })`, a named export.
  - `series`: `Array<{ym: string, label: string, income: number, expenses: number, net: number, special: number}>`, ascending by month.
  - `months`: `number` — window length.
  - `currentYm`: `string` — `'YYYY-MM'` of the month in progress.
  - Returns `null`, or `{months: number, monthsUsed: number, from: string, to: string, inclSpecial: number, exclSpecial: number, emptyYms: string[]}`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/runningAverage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunningAverage } from '../lib/runningAverage.js';

// A month shaped exactly as routes/analytics.js builds it. `special` is already
// zeroed server-side when the user's preference is off, so tests set it directly.
const m = (ym, expenses, { income = 2000, special = 0 } = {}) => ({
  ym,
  label: ym,
  income,
  expenses,
  net: income - expenses,
  special,
});

const empty = (ym) => ({ ym, label: ym, income: 0, expenses: 0, net: 0, special: 0 });

// Jan–Dec 2026 at 100, 200, … 1200. Used by the windowing tests.
const twelveMonths = () =>
  Array.from({ length: 12 }, (_, i) => m(`2026-${String(i + 1).padStart(2, '0')}`, (i + 1) * 100));

test('averages the last six completed months, excluding the month in progress', () => {
  const series = [
    m('2026-02', 1300),
    m('2026-03', 1100),
    m('2026-04', 1250),
    m('2026-05', 1180),
    m('2026-06', 1320),
    m('2026-07', 1290),
    m('2026-08', 410), // in progress — must not count
  ];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 6);
  assert.equal(r.from, '2026-02');
  assert.equal(r.to, '2026-07');
  assert.equal(r.inclSpecial, 1240); // 7440 / 6
});

test('shorter history than the window: averages what exists and reports the count', () => {
  const series = [m('2026-05', 1000), m('2026-06', 1100), m('2026-07', 1200), m('2026-08', 300)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 3);
  assert.equal(r.inclSpecial, 1100);
});

test('no completed months at all returns null', () => {
  const r = buildRunningAverage({ series: [m('2026-08', 410)], months: 6, currentYm: '2026-08' });
  assert.equal(r, null);
});

test('leading pre-signup months are trimmed and do not dilute the mean', () => {
  const series = [
    empty('2026-01'),
    empty('2026-02'),
    m('2026-03', 1000),
    m('2026-04', 1200),
    m('2026-05', 800),
  ];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 3);
  assert.equal(r.from, '2026-03');
  assert.equal(r.inclSpecial, 1000); // 3000 / 3, NOT 3000 / 5
  assert.deepEqual(r.emptyYms, []);
});

test('a zero month INSIDE the history counts as £0 and is reported', () => {
  const series = [m('2026-04', 1200), empty('2026-05'), m('2026-06', 1200)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 3);
  assert.equal(r.inclSpecial, 800); // 2400 / 3 — the gap pulls it down
  assert.deepEqual(r.emptyYms, ['2026-05']);
});

test('multiple gaps are all reported, in ascending order', () => {
  const series = [
    m('2026-03', 900),
    empty('2026-04'),
    m('2026-05', 900),
    empty('2026-06'),
    m('2026-07', 900),
  ];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.deepEqual(r.emptyYms, ['2026-04', '2026-06']);
  assert.equal(r.inclSpecial, 540); // 2700 / 5
});

test('a trimmed LEADING zero month is not reported as a gap', () => {
  const series = [empty('2026-02'), m('2026-03', 1000), empty('2026-04'), m('2026-05', 1000)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.deepEqual(r.emptyYms, ['2026-04']);
  assert.equal(r.monthsUsed, 3);
  assert.equal(r.inclSpecial, 666.67); // 2000 / 3, rounded
});

test('special spend lowers exclSpecial by exactly its mean', () => {
  const series = [
    m('2026-05', 1000, { special: 300 }),
    m('2026-06', 1000, { special: 0 }),
    m('2026-07', 1000, { special: 600 }),
  ];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.inclSpecial, 1000);
  assert.equal(r.exclSpecial, 700); // (700 + 1000 + 400) / 3
});

test('preference off (no special anywhere) leaves the two figures equal', () => {
  const series = [m('2026-06', 1000), m('2026-07', 1400)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.inclSpecial, 1200);
  assert.equal(r.exclSpecial, 1200);
});

test('more completed months than the window: only the last N are used', () => {
  const r = buildRunningAverage({ series: twelveMonths(), months: 6, currentYm: '2027-01' });
  assert.equal(r.from, '2026-07');
  assert.equal(r.to, '2026-12');
  assert.equal(r.inclSpecial, 950); // (700+800+900+1000+1100+1200) / 6
});

test('exactly one completed month', () => {
  const series = [m('2026-07', 1234.56), m('2026-08', 100)];
  const r = buildRunningAverage({ series, months: 6, currentYm: '2026-08' });
  assert.equal(r.monthsUsed, 1);
  assert.equal(r.from, '2026-07');
  assert.equal(r.to, '2026-07');
  assert.equal(r.inclSpecial, 1234.56);
});

test('the 3 / 6 / 12 windows differ, and a window longer than the history clamps', () => {
  const series = twelveMonths();
  const at = (months) => buildRunningAverage({ series, months, currentYm: '2027-01' });
  assert.equal(at(3).inclSpecial, 1100); // (1000+1100+1200) / 3
  assert.equal(at(6).inclSpecial, 950);
  assert.equal(at(12).inclSpecial, 650); // 7800 / 12
  assert.equal(at(24).monthsUsed, 12);
  assert.equal(at(24).inclSpecial, 650);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server && npm test
```

Expected: every test fails with `Cannot find module '../lib/runningAverage.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/lib/runningAverage.js`:

```js
// The one definition of "what a normal month costs". Kept out of the route and
// out of the component for the same reason lib/overallBudget.js exists: a figure
// computed in two places eventually disagrees with itself on the same screen.
//
// COMPLETED months only. The month in progress is deliberately excluded — on the
// 10th, a third of a month's spending would drag the mean down, and the figure
// would creep upward all month instead of meaning "a normal month".

function isEmptyMonth(month) {
  return month.income === 0 && month.expenses === 0;
}

function mean(values) {
  const total = values.reduce((sum, v) => sum + v, 0);
  return Number((total / values.length).toFixed(2));
}

/**
 * @param {object} args
 * @param {Array<{ym: string, income: number, expenses: number, special: number}>} args.series
 *   Ascending months, as built by routes/analytics.js.
 * @param {number} args.months How many completed months to average over.
 * @param {string} args.currentYm 'YYYY-MM' of the month in progress.
 * @returns {null | {months: number, monthsUsed: number, from: string, to: string,
 *                   inclSpecial: number, exclSpecial: number, emptyYms: string[]}}
 */
export function buildRunningAverage({ series, months, currentYm }) {
  // 1. Drop leading pre-signup months. Same rule as MonthlyHistory.jsx:11, so the
  //    average and the history list agree on when the user's data starts.
  const firstWithData = series.findIndex((month) => !isEmptyMonth(month));
  const active = firstWithData === -1 ? [] : series.slice(firstWithData);

  // 2. Completed months only. Matched on ym rather than position, so this does
  //    not depend on how the caller sliced the series.
  const completed = active.filter((month) => month.ym !== currentYm);

  // 3. The window.
  const picked = completed.slice(-months);
  if (picked.length === 0) return null;

  return {
    months,
    monthsUsed: picked.length,
    from: picked[0].ym,
    to: picked[picked.length - 1].ym,
    inclSpecial: mean(picked.map((month) => month.expenses)),
    exclSpecial: mean(picked.map((month) => month.expenses - month.special)),
    // Anything still empty here is a genuine gap mid-history — step 1 already
    // removed the pre-signup run — so it may be a month the user forgot to log.
    emptyYms: picked.filter(isEmptyMonth).map((month) => month.ym),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && npm test
```

Expected: 12 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add server/lib/runningAverage.js server/test/runningAverage.test.js
git commit -m "Running average: the completed-months rule, with 12 unit tests"
```

---

### Task 2: Serve it from /api/analytics

**Files:**
- Modify: `server/routes/analytics.js` (import at top; new block after line 111; one key in `res.json`)

**Interfaces:**
- Consumes: `buildRunningAverage({series, months, currentYm})` from Task 1.
- Produces: `/api/analytics` response gains `average`, either `null` or
  `{windows: Array<WindowResult>, thisMonthSoFar: number, thisMonthSpecial: number}`,
  where `WindowResult` is Task 1's return shape and `windows` always holds exactly
  three entries (`months` 3, 6 and 12) in that order.

- [ ] **Step 1: Add the import**

At the top of `server/routes/analytics.js`, after the `supabase` import (line 2):

```js
import { buildRunningAverage } from '../lib/runningAverage.js';
```

- [ ] **Step 2: Build the `average` block**

Insert **after** the `deltaPct` const (line 111) and **before** `res.json`. This position matters: the block reuses `thisMonthBucket` and `thisMonthExpenses`, which are declared at lines 104-106 — not earlier, at the rounding loop.

```js
    // Three windows in one response so the card's 3m / 6m / 12m switch needs no
    // refetch. Two extra passes over an in-memory array of at most 24 entries.
    // `windows` is all-or-nothing: buildRunningAverage only returns null when
    // there is no completed month at all, which is true for every window or none.
    const windows = [3, 6, 12]
      .map((n) => buildRunningAverage({ series, months: n, currentYm: thisYm }))
      .filter(Boolean);

    // thisMonth* sit outside `windows` because they do not vary by window, and
    // they are read straight from the current bucket — untouched by the trimming
    // and windowing that shape the averages.
    const average = windows.length
      ? {
          windows,
          thisMonthSoFar: thisMonthExpenses,
          thisMonthSpecial: thisMonthBucket?.special ?? 0,
        }
      : null;
```

Note: the map parameter is `n`, not `months` — `months` is already bound at line 20.

- [ ] **Step 3: Add it to the response**

In the `res.json({...})` call, add `average,` after `series,`:

```js
    res.json({
      series,
      average,
      topCategories,
      mom: {
        thisMonth: thisMonthExpenses,
        lastMonth: lastMonthExpenses,
        deltaPct,
      },
    });
```

- [ ] **Step 4: Verify the server starts and the route is intact**

```bash
cd server && node --check routes/analytics.js && npm test
```

Expected: no syntax error, 12 tests still passing.

- [ ] **Step 5: Commit**

```bash
git add server/routes/analytics.js
git commit -m "Running average: serve 3/6/12-month windows from /api/analytics"
```

---

### Task 3: Let the Quick Add dialog open on a chosen date

**Files:**
- Modify: `client/src/components/QuickAddDialog.jsx` (props at line 36-42; state at line 50; reset effect at lines 69-86; success handler at lines 134-140; advanced block at line 504)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `QuickAddDialog` accepts one new optional prop, `initialDate: string` (`'YYYY-MM-DD'`), defaulting to today. Existing callers pass nothing and are unaffected.

- [ ] **Step 1: Add the prop**

Change the signature (lines 36-42) to:

```jsx
export function QuickAddDialog({
  open,
  onOpenChange,
  currency = 'GBP',
  simpleMode = false,
  specialEnabled = false,
  initialDate = todayISO(),
}) {
```

- [ ] **Step 2: Seed the date state from it**

Line 50 becomes:

```jsx
  const [date, setDate] = useState(initialDate);
```

- [ ] **Step 3: Re-seed on open, and reveal the date when it is not today**

In the reset-on-open effect (lines 69-86), replace `setDate(todayISO());` and `setShowMore(false);` with:

```jsx
      setDate(initialDate);
      // Auto-open the advanced section when the date is not today, so a pre-dated
      // add is never invisible. Same rule as line ~200, where the AI parser moving
      // the date off today already does this.
      setShowMore(initialDate !== todayISO());
```

and change the dependency array on that effect from `[open]` to `[open, initialDate]`.

- [ ] **Step 4: Stop simple mode hiding a pre-dated date**

Line 504 becomes:

```jsx
            <div className={simpleMode && initialDate === todayISO() ? 'hidden' : undefined}>
```

Simple mode still hides the advanced block for ordinary adds; it never hides a date the user is being asked to confirm.

- [ ] **Step 5: Invalidate the analytics cache on success**

In the success handler (lines 134-140), add alongside the existing invalidations:

```jsx
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
```

This is a **pre-existing bug fix**: adding a backdated expense from the Dashboard today leaves the Analytics page showing stale figures until a hard refresh. Without it, the empty-month prompt built in Task 4 would stay on screen after the user acts on it. The Analytics query key is `['analytics', 24]`, and TanStack Query v5 matches by prefix, so `['analytics']` covers it.

- [ ] **Step 6: Verify the build and that the Dashboard is unaffected**

```bash
cd client && npm run build
```

Expected: build succeeds. Then start the dev server, open the Dashboard, press the **+** button, and confirm the date still defaults to today and the advanced section still starts closed.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/QuickAddDialog.jsx
git commit -m "Quick Add: optional initialDate, and invalidate analytics on success"
```

---

### Task 4: The average card

**Files:**
- Create: `client/src/components/AverageMonthCard.jsx`

**Interfaces:**
- Consumes: the `average` object from Task 2.
- Produces: `AverageMonthCard({average, currency, onAddToMonth})`, a named export.
  `average` is Task 2's object or `null`. `onAddToMonth` is called with a
  `'YYYY-MM-DD'` string when the user presses the empty-month prompt.

- [ ] **Step 1: Write the component**

Create `client/src/components/AverageMonthCard.jsx`:

```jsx
import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

const WINDOWS = [3, 6, 12];
const WINDOW_KEY = 'trim:avgWindow';
const SPECIAL_KEY = 'trim:avgIncludeSpecial';

// Deliberately NOT the Dashboard hero's trim:heroIncludeSpecial. The hero toggles
// this month's net; this toggles an N-month expense average. Flipping one should
// not silently change a page the user is not looking at.
function readWindow() {
  try {
    const stored = Number(localStorage.getItem(WINDOW_KEY));
    return WINDOWS.includes(stored) ? stored : 6;
  } catch {
    return 6; // private mode / storage disabled
  }
}

function readIncludeSpecial() {
  try {
    return localStorage.getItem(SPECIAL_KEY) !== 'false';
  } catch {
    return true;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not being able to remember the choice is not worth an error.
  }
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Parsed off the string rather than through Date, which would reintroduce the
// timezone off-by-one the server already avoids with timeZone: 'UTC'.
const monthName = (ym) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
const yearOf = (ym) => ym.slice(0, 4);

/** 'Feb–Jul 2026', 'Sep 2025–Feb 2026', or plain 'Jul 2026' for a single month. */
function windowLabel(from, to) {
  if (from === to) return `${monthName(from)} ${yearOf(from)}`;
  if (yearOf(from) === yearOf(to)) return `${monthName(from)}–${monthName(to)} ${yearOf(to)}`;
  return `${monthName(from)} ${yearOf(from)}–${monthName(to)} ${yearOf(to)}`;
}

export function AverageMonthCard({ average, currency, onAddToMonth }) {
  const [months, setMonths] = useState(readWindow);
  const [includeSpecial, setIncludeSpecial] = useState(readIncludeSpecial);

  if (!average) return null;

  const picked = average.windows.find((w) => w.months === months) ?? average.windows[0];
  // Only worth offering when there IS special spend in this window to take out —
  // the same rule the Dashboard hero uses.
  const canToggle = picked.inclSpecial !== picked.exclSpecial;
  const excluding = canToggle && !includeSpecial;

  const figure = excluding ? picked.exclSpecial : picked.inclSpecial;
  // Compare like with like: an excl.-special average next to an incl.-special
  // "this month so far" would be two different measures side by side.
  const thisMonth = excluding
    ? average.thisMonthSoFar - average.thisMonthSpecial
    : average.thisMonthSoFar;

  const gaps = picked.emptyYms;

  function chooseWindow(n) {
    setMonths(n);
    remember(WINDOW_KEY, n);
  }

  function toggleSpecial() {
    const next = !includeSpecial;
    setIncludeSpecial(next);
    remember(SPECIAL_KEY, next);
  }

  return (
    <Card className="lift border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Average month · last {picked.monthsUsed} completed
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Averaging window"
              className="flex rounded-full border border-border/70 bg-background/40 p-0.5"
            >
              {WINDOWS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => chooseWindow(n)}
                  aria-pressed={n === months}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                    n === months
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {n}m
                </button>
              ))}
            </div>
            {canToggle ? (
              <button
                type="button"
                onClick={toggleSpecial}
                aria-pressed={excluding}
                className="rounded-full border border-border/70 bg-background/40 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-amber-400/50 hover:text-amber-400"
              >
                {excluding ? 'excl. special' : 'incl. special'}
              </button>
            ) : null}
          </div>
        </div>

        <p className="nums mt-1 text-3xl font-extrabold tracking-tight text-gradient sm:text-4xl">
          {formatMoney(figure, currency)}
        </p>

        <p className="mt-1 text-xs text-muted-foreground">
          {windowLabel(picked.from, picked.to)} · this month so far{' '}
          <span className="nums">{formatMoney(thisMonth, currency)}</span>
        </p>

        {gaps.length > 0 ? (
          <button
            type="button"
            onClick={() => onAddToMonth(`${gaps[gaps.length - 1]}-01`)}
            className="mt-3 flex w-full items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-left text-xs text-amber-400 transition-colors hover:bg-amber-400/10"
          >
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {gaps.length === 1
                ? `1 month with nothing logged (${monthName(gaps[0])})`
                : `${gaps.length} months with nothing logged (${gaps.map(monthName).join(', ')})`}
              {' — add an expense'}
            </span>
          </button>
        ) : null}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify the build**

```bash
cd client && npm run build
```

Expected: build succeeds. (The card is not mounted yet, so nothing is visible — that is Task 5.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/AverageMonthCard.jsx
git commit -m "Running average: the Analytics card"
```

---

### Task 5: Mount the card and wire up backdating

**Files:**
- Modify: `client/src/pages/Analytics.jsx` (imports at lines 1-16; destructure at line 54; render above line 67; new dialog at the end of the returned tree)

**Interfaces:**
- Consumes: `AverageMonthCard` (Task 4), `QuickAddDialog`'s `initialDate` (Task 3), `average` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the imports**

At the top of `client/src/pages/Analytics.jsx`:

```jsx
import { useState } from 'react';
```

and alongside the existing `MonthlyHistory` import:

```jsx
import { AverageMonthCard } from '@/components/AverageMonthCard';
import { QuickAddDialog } from '@/components/QuickAddDialog';
```

- [ ] **Step 2: Hold the backdating date**

Inside `export default function Analytics()`, next to the existing hooks (before any early return, so hook order stays stable):

```jsx
  // 'YYYY-MM-DD' while the backdating dialog is open, null when it is closed.
  const [backdateTo, setBackdateTo] = useState(null);
```

- [ ] **Step 3: Pull `average` out of the response**

Line 54 becomes:

```jsx
  const { series, average, topCategories, mom } = data;
```

- [ ] **Step 4: Render the card at the top**

Immediately after the `</header>` block and before the `This month / Last month / Change` card:

```jsx
      <AverageMonthCard average={average} currency={currency} onAddToMonth={setBackdateTo} />
```

- [ ] **Step 5: Mount the dialog**

As the last child of the outer `<div>`, after `<MonthlyHistory … />`:

```jsx
      <QuickAddDialog
        open={backdateTo !== null}
        onOpenChange={(next) => {
          if (!next) setBackdateTo(null);
        }}
        currency={currency}
        simpleMode={!!me?.preferences?.simpleMode}
        specialEnabled={!!me?.preferences?.specialExpensesEnabled}
        initialDate={backdateTo ?? undefined}
      />
```

`initialDate={backdateTo ?? undefined}` lets the prop's own `todayISO()` default apply while closed. The dialog's category query is `enabled: open`, so mounting it closed costs no request.

- [ ] **Step 6: Verify the build**

```bash
cd client && npm run build
```

Expected: build succeeds.

- [ ] **Step 7: Verify it in the running app** — this is the step that has been skipped before

Start both servers, log in, and go to **Analytics**. Confirm all of:

1. The card is the first thing under the "Analytics" heading.
2. Switching **3m / 6m / 12m** changes the figure and the date range, with no loading flicker (no refetch).
3. The heading matches reality — with 8 months of history, "12m" reads "last 8 completed".
4. If there is special spend in the window, the **incl./excl. special** pill appears and changes both the big figure and "this month so far".
5. Reload the page: the window and the pill are where you left them.
6. If a gap month exists, the amber prompt appears; pressing it opens Quick Add with **the date field visible** and set to the 1st of that month; saving an expense makes both the average and the prompt update **without a page reload**.
7. The Dashboard's own hero toggle is unchanged by anything done on Analytics.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/Analytics.jsx
git commit -m "Running average: mount the card on Analytics, wire up backdating"
```

---

### Task 6: Documentation and baton

**Files:**
- Modify: `FEATURES.md`, `BUILD_PLAN.md`, `CHAT_HANDOFF.md`

- [ ] **Step 1: Document the feature**

In `FEATURES.md`, in the Analytics section, describe: the card, the 3/6/12 switch, that averages cover **completed months only** and why, the incl./excl. toggle and its separate memory from the Dashboard hero's, and the empty-month prompt with its backdating route.

- [ ] **Step 2: Record the work**

In `BUILD_PLAN.md`, add the feature under a new Phase 11 heading with its items ticked.

- [ ] **Step 3: Update the baton**

In `CHAT_HANDOFF.md`, update the `## DUAL-AGENT BATON` block: what was built, that it is on `main`, and whether it has been deployed. Note that this was ordinary single-model feature work, per `CLAUDE.md`'s rule that the full loop is reserved for big or risky changes.

- [ ] **Step 4: Commit**

```bash
git add FEATURES.md BUILD_PLAN.md CHAT_HANDOFF.md
git commit -m "Docs: running average of monthly expenses"
```

---

## Self-review notes

**Spec coverage** — every section of the spec maps to a task: Component 1 → Task 1; Component 2 → Task 2; Component 3 → Task 4; Component 4 → Task 3; the twelve unit tests → Task 1 Step 1; the manual checks → Task 5 Step 7; definition of done → Task 6.

**One thing the plan adds beyond the spec:** the sub-line's "this month so far" follows the incl./excl. toggle (Task 4, the `thisMonth` const). The spec provided `thisMonthSpecial` for exactly this but did not spell out the comparison rule. Showing an excl.-special average beside an incl.-special current month would be two different measures side by side.

**Ordering** — Task 3 comes before Tasks 4-5 because Task 5 passes `initialDate`, which does not exist until Task 3. Tasks 1-2 are independent of Task 3 and could run in parallel with it.
