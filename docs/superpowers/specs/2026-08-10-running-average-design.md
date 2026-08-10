# Running average of monthly expenses — design

**Date:** 2026-08-10 (revised same day after Alex's answers)
**Status:** revised, awaiting Alex's re-approval
**Scope:** one card on the Analytics page with a 3/6/12-month switch, one new server lib, one
additive field on `/api/analytics`, and one new prop on the existing Quick Add dialog. No database
change, no new query, no migration.

## The ask

> "Get running average over past 6 months for monthly expenses to see how much I've been
> spending on average recently; and have one total without special expenses and one with
> again, toggled like with the dashboard."

Plus, from the follow-up round: a switchable 3/6/12-month window; a flag on the card when a month
in the window has nothing logged; and a way to add expenses to a past month from there.

## What the number means

**The average of the last N *completed* calendar months' expenses**, N being 3, 6 or 12.

Alex chose completed months over a window that includes the current part-month. On the day this was
designed (10 August) only a third of August had happened, so including it would have dragged the
average down and made it creep upward all month. The figure only moves when a month closes, which
is what makes it usable as "what a normal month costs me".

The current month still appears on the card, as a separate "this month so far" comparison — never
mixed into the average.

## Decisions and their reasons

| Decision | Chosen | Why |
|---|---|---|
| Window | Last N **completed** months | Stable; a part-month biases the mean low. |
| Window lengths | 3 / 6 / 12, default 6 | Alex asked for the switch. All three computed server-side in one response, so switching is instant. |
| Placement | Analytics page only | It is already the multi-month view and already fetches the data. The Dashboard is dense and its hero is about *this* month. |
| Where the maths lives | Server, in a tested lib | See "Why the server" below. |
| incl./excl. toggle memory | Its own key, separate from the Dashboard's | The two toggles answer different questions. |
| Short history | Average what exists, report the count | Dividing 3 months by 6 would be silently wrong. |
| Zero month inside history | Counts as £0, **and is flagged** | A real month with no spending is real data. But it might instead be a month Alex forgot to log, so the card says so rather than quietly reporting a flattering average. |
| Fixing a forgotten month | Reuse the existing Quick Add dialog, pre-dated | The capability already exists; only its discoverability is missing. See below. |

### Why the server, not the component

Phase 10's review found that `projections.js` and `affordability.js` computed "your total budget"
two different ways and disagreed on the same screen. The fix was to move the rule into one tested
file, `server/lib/overallBudget.js`. "What counts as an average month" is the same kind of rule: a
definition, not a display detail.

The server has `node --test` wired up (`npm test`); the client has no test runner at all, so a
client-side version of this rule would ship untested. Computing it server-side also means that if
the average is ever wanted on the Dashboard, it is one import rather than a copy-paste.

### Backdating already exists — this is a discoverability fix

Verified while revising this spec:

- `POST /api/transactions` takes an optional `date` (`server/routes/transactions.js:23`), validated
  only as `YYYY-MM-DD` (`isoDate`, line 10). **There is no limit on how far back it may be**, and
  the route has deliberate handling for back/post-dated rows (lines 121, 129-130).
- `PATCH /api/transactions/:id` accepts `date` too (line 37, applied at line 324).
- In the UI: Quick Add → the "Change the date or repeat it" disclosure
  (`client/src/components/QuickAddDialog.jsx:503-528`); and Transactions → edit a row → Date field
  (`client/src/pages/Transactions.jsx:121-122`).

So no new backdating capability is needed. Two gaps stop it being *reachable* from the new card:

1. **The Transactions page has no add button.** `QuickAddButton` is rendered only from
   `Dashboard.jsx:319`. Linking the flag to `/transactions?month=2026-03` would land on an empty
   list with nothing to press.
2. **Simple mode hides the date field entirely** — the whole advanced block is
   `className={simpleMode ? 'hidden' : undefined}` (`QuickAddDialog.jsx:504`).

The design therefore opens the existing Quick Add dialog directly from the card, pre-dated to the
missing month, and makes the date visible when it has been pre-dated.

## Component 1 — `server/lib/runningAverage.js`

A pure function, one window per call. No I/O, no Supabase, no clock of its own — the caller passes
the current month in, which is what makes it testable.

```js
buildRunningAverage({ series, months, currentYm })
```

**Input.** `series` is the ascending month array `server/routes/analytics.js` already builds:
`{ ym, label, income, expenses, net, special }` per month, values already rounded to 2dp.
`currentYm` is the `YYYY-MM` key of the month in progress.

**Algorithm.**

1. Trim leading months with no activity (`income === 0 && expenses === 0`) — the same rule
   `client/src/components/MonthlyHistory.jsx:11` already applies, so pre-signup months do not
   dilute the average. Only *leading* months are trimmed; a zero month inside the history stays.
2. Drop the entry whose `ym === currentYm`. (It is the last entry when present, but match on `ym`
   rather than position so the function does not depend on the caller's slicing.)
3. Take the last `months` of what remains.
4. Return the two means, rounded with `Number(x.toFixed(2))` — the same rounding
   `server/routes/analytics.js:84-87` already applies to the series.

**Output.**

```js
{
  months: 6,                 // the window that was asked for
  monthsUsed: 6,             // may be fewer, when history is shorter
  from: '2026-02',
  to: '2026-07',
  inclSpecial: 1240.50,      // mean of m.expenses
  exclSpecial: 980.00,       // mean of (m.expenses - m.special)
  emptyYms: [],              // months inside the window with nothing logged
}
```

Returns `null` when step 3 leaves no months — a brand-new account with no completed month.

`emptyYms` lists the `ym` of every month **inside the used window** with `income === 0 &&
expenses === 0`. Because step 1 has already removed leading pre-signup months, anything left is a
genuine gap in the middle of an active history. The card uses both its length (for the count) and
its last entry (the most recent gap, for the pre-dated Quick Add).

**Special expenses.** The `special` field in `series` is already zero whenever the user's
`special_expenses_enabled` preference is off (`server/routes/analytics.js:76`, matching the guard
in `server/lib/special.js`). `buildRunningAverage` therefore needs no preference flag of its own:
when the preference is off, `exclSpecial === inclSpecial` and the client suppresses the toggle.
`special` also counts expenses only, never income, for the same reason.

## Component 2 — `server/routes/analytics.js`

Inserted **after the `mom` values are computed** (`server/routes/analytics.js:104-111`) and before
`res.json`. That position matters: the block below reuses `thisMonthBucket` and `thisMonthExpenses`,
which are declared there, not earlier at the rounding loop.

```js
const windows = [3, 6, 12]
  .map((m) => buildRunningAverage({ series, months: m, currentYm: thisYm }))
  .filter(Boolean);

const average = windows.length
  ? { windows, thisMonthSoFar: thisMonthExpenses, thisMonthSpecial: thisMonthBucket?.special ?? 0 }
  : null;
```

`average` joins `series`, `topCategories` and `mom` in the JSON. `thisYm`, `thisMonthExpenses` and
`thisMonthBucket` all already exist in that function.

`thisMonthSoFar` and `thisMonthSpecial` sit outside `windows` because they do not vary by window,
and they are read straight from the current month's bucket — untouched by the trimming and
windowing that shape the averages.

All three windows are computed in one response so the client can switch instantly with no refetch.
The cost is two extra passes over an in-memory array of at most 24 entries. **No new Supabase
query** — the transactions are already fetched for the series.

`windows` is always either empty or all three: `buildRunningAverage` returns `null` only when there
is no completed month at all, which is true for every window or none of them. The client therefore
never has to handle a partial set, and `average === null` is the single "nothing to show" signal.

Note that `Analytics.jsx` requests `months=24`, so the windows are applied by the lib, not by the
query string. That is deliberate: the page also renders 24 months of history.

This is **purely additive** — every existing consumer of `/api/analytics` keeps working unchanged.

## Component 3 — `client/src/components/AverageMonthCard.jsx`

Rendered at the top of `client/src/pages/Analytics.jsx`, above the existing This month / Last month
/ Change card. Returns `null` when `average` is `null`.

```
┌─ Average month · last 6 completed ──────────────────────┐
│  £1,240                    [3m|6m|12m]  [ incl. special ]│
│  Feb–Jul 2026 · this month so far £410                   │
│  ⚠ 1 month with nothing logged (Mar) — add an expense →  │
└──────────────────────────────────────────────────────────┘
```

- **Heading** names the window honestly using the selected window's `monthsUsed`:
  "last 6 completed" / "last 3 completed".
- **Figure** is `inclSpecial` or `exclSpecial` depending on the toggle, through `formatMoney` with
  the user's currency, matching the rest of the page.
- **Window switch** is a 3-way segmented control (3m / 6m / 12m). All three windows are already in
  the response, so switching re-renders with no network call. Windows the history cannot fill still
  appear, and label themselves with their real `monthsUsed` — with 8 months of history, "12m" reads
  "last 8 completed" rather than pretending.
- **incl./excl. toggle** is a pill button matching the Dashboard hero's behaviour and styling
  (`client/src/pages/Dashboard.jsx:143-152`): `aria-pressed`, `incl. special` / `excl. special`.
  Rendered **only when `inclSpecial !== exclSpecial`** for the selected window — the same "only
  offer the toggle when it does something" rule the hero uses.
- **Sub-line** shows the window and `thisMonthSoFar`. The window label is built from `from` and
  `to`, printing the year once when they share one and twice when they do not: `Feb–Jul 2026`,
  `Sep 2025–Feb 2026`. When `monthsUsed === 1` it collapses to a single month, `Jul 2026`, rather
  than repeating it either side of a dash.
- **Empty-month flag** reads the **selected window's** `emptyYms` and appears only when it is
  non-empty — so switching 3m → 12m can reveal or hide it. "N months with nothing logged",
  naming them (`Mar`, or `Mar, May, Jun`). It is a **button**, not static text — pressing it opens
  the Quick Add dialog dated to the **most recent** month in `emptyYms`, on the **1st** of that
  month (arbitrary but predictable, and editable in the dialog).

**Two independent memories**, both in `localStorage`, both wrapped in try/catch exactly as
`readIncludeSpecial()` in `Dashboard.jsx:91` is — private browsing must not throw:

- `trim:avgIncludeSpecial` — the incl./excl. choice, defaulting to including. A **separate** key
  from the hero's `trim:heroIncludeSpecial` by design: the hero toggles *this month's net*, this
  toggles *an N-month expense average*, and flipping one should not silently change the other page.
- `trim:avgWindow` — the selected window, defaulting to `6`. A stored value that is not 3, 6 or 12
  falls back to 6.

## Component 4 — `initialDate` on the Quick Add dialog

`client/src/components/QuickAddDialog.jsx` gains one optional prop:

```js
initialDate = todayISO()
```

Three changes, all small, none affecting existing callers (the Dashboard passes nothing and keeps
today's date):

1. `const [date, setDate] = useState(initialDate)` (line 50).
2. In the reset-on-open effect (lines 69-86), `setDate(initialDate)` instead of `setDate(todayISO())`,
   with `initialDate` added to the dependency array, so reopening the dialog for a different month
   re-seeds correctly.
3. The date must be **visible when it has been pre-dated**, including in simple mode. Two parts:
   - `setShowMore(initialDate !== todayISO())` in the same effect — this mirrors the existing
     behaviour at line 200, which already auto-opens the advanced section when the AI parser moves
     the date off today. Same rule, new trigger.
   - The advanced block's `className={simpleMode ? 'hidden' : undefined}` (line 504) becomes
     `className={simpleMode && initialDate === todayISO() ? 'hidden' : undefined}`, so simple mode
     still hides it for ordinary adds but never hides a date the user is being asked to confirm.

`Analytics.jsx` mounts `QuickAddDialog` itself (not `QuickAddButton` — no floating action button on
this page), passing `currency`, `simpleMode`, `specialEnabled` from `/api/me`, and `initialDate`.

On success the dialog already invalidates the `dashboard`, `transactions`, `wins` and `projections`
query keys (lines 134-140). **It does not invalidate `analytics`**, so the card would keep showing
the stale average and the stale flag after the user fixes a month. Add `analytics` to that list —
a one-line fix that also corrects the pre-existing gap where adding a backdated expense from the
Dashboard left the Analytics page stale.

## Testing

`server/test/runningAverage.test.js`, `node --test`, following `server/test/overallBudget.test.js`:

1. Six full completed months plus a part-month → correct mean; the part-month is excluded.
2. Only three completed months, `months: 6` → mean over 3, `monthsUsed === 3`.
3. No completed months → `null`.
4. Leading pre-signup zero months are trimmed and do not dilute the mean.
5. A zero month *inside* the history is included, pulls the mean down, and appears in `emptyYms`.
6. Multiple gaps → `emptyYms` holds all of them, in ascending order.
7. A leading zero month is trimmed and does **not** appear in `emptyYms`.
8. Special present → `exclSpecial` is lower than `inclSpecial` by the right amount.
9. Preference off (all `special` are 0) → the two figures are equal.
10. More than N completed months → only the last N are used.
11. Exactly one completed month → `monthsUsed === 1`, `from === to`, mean equals that month.
12. The 3 / 6 / 12 windows over the same series produce the three expected means, and a window
    longer than the history clamps to `monthsUsed === history length`.

Manual, in the running app:

- Analytics → card is at the top; switch 3m/6m/12m and watch the figure and the date range change.
- Flip incl./excl. special and watch the figure change.
- If a gap month exists: press the flag, confirm Quick Add opens with that month's date **visible**,
  add an expense, and confirm the card's average and flag both update without a page reload.

## Definition of done

Per `CLAUDE.md`:

1. `npm test` passes in `server/`; `npm run build` passes in `client/`; the server starts cleanly.
2. The card is **reachable in the running app** — Analytics page, top card, all controls exercised.
3. `FEATURES.md` and `BUILD_PLAN.md` updated in the same session. `SECURITY.md` is untouched: no
   change to auth, RLS or data access.
4. Committed on `main`.

## Explicitly out of scope

- The Dashboard comparison line ("vs £1,240 avg"). Considered and not chosen.
- Per-category averages ("you average £320/month on Food"). A bigger feature — own card, own maths,
  own tests — not a tweak to this one.
- Adding a Quick Add button to the Transactions page. Tempting given gap #1 above, but the card
  opens the dialog directly, so it is not needed for this feature.
- Any change to how special expenses are flagged, grouped or stored.
