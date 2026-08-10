# Six-month running average of monthly expenses — design

**Date:** 2026-08-10
**Status:** approved by Alex, ready to plan
**Scope:** one card on the Analytics page, one new server lib, one additive field on
`/api/analytics`. No database change, no new query, no migration.

## The ask

> "Get running average over past 6 months for monthly expenses to see how much I've been
> spending on average recently; and have one total without special expenses and one with
> again, toggled like with the dashboard."

## What the number means

**The average of the last six *completed* calendar months' expenses.**

Alex chose completed months over a window that includes the current part-month. On the day this
was designed (10 August) only a third of August had happened, so including it would have dragged
the average down and made it creep upward all month. The figure only moves when a month closes,
which is what makes it usable as "what a normal month costs me".

The current month is still shown on the card, but as a separate "this month so far" comparison —
never mixed into the average.

## Decisions and their reasons

| Decision | Chosen | Why |
|---|---|---|
| Window | Last 6 **completed** months | Stable; a part-month biases the mean low. |
| Placement | Analytics page only | It is already the six-month view and already fetches the data. The Dashboard is dense and its hero is about *this* month. |
| Where the maths lives | Server, in a tested lib | See "Why the server" below. |
| Toggle memory | Its own key, separate from the Dashboard's | The two toggles answer different questions. |
| Short history | Average what exists, report the count | Dividing 3 months by 6 would be silently wrong. |
| Zero month inside history | Counts as £0 | A real month with no spending. Excluding it would flatter the average. |

### Why the server, not the component

Phase 10's review found that `projections.js` and `affordability.js` computed "your total budget"
two different ways and disagreed on the same screen. The fix was to move the rule into one tested
file, `server/lib/overallBudget.js`. "What counts as an average month" is the same kind of rule: a
definition, not a display detail.

The server has `node --test` wired up (`npm test`); the client has no test runner at all, so a
client-side version of this rule would ship untested. Computing it server-side also means that if
the average is ever wanted on the Dashboard, it is one import rather than a copy-paste.

The cost over doing it in `Analytics.jsx` is one extra file.

## Component 1 — `server/lib/runningAverage.js`

A pure function. No I/O, no Supabase, no clock of its own — the caller passes the current month in,
which is what makes it testable.

```js
buildRunningAverage({ series, months = 6, currentYm })
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

`thisMonthSoFar` and `thisMonthSpecial` are read from the **input** `series`, before steps 1–3, so
the trimming and windowing that shape the average cannot affect them. Both are `0` when the current
month is not in the series at all.

**Output.**

```js
{
  monthsUsed: 6,            // may be fewer than `months`
  from: '2026-02',
  to: '2026-07',
  inclSpecial: 1240.50,     // mean of m.expenses
  exclSpecial: 980.00,      // mean of (m.expenses - m.special)
  thisMonthSoFar: 410.00,   // current month's expenses, or 0 if absent
  thisMonthSpecial: 60.00,  // current month's special, or 0 if absent
}
```

Returns `null` when step 3 leaves no months — a brand-new account with no completed month. The
card then does not render.

**Special expenses.** The `special` field in `series` is already zero whenever the user's
`special_expenses_enabled` preference is off (`server/routes/analytics.js:76`, matching the guard
in `server/lib/special.js`). `buildRunningAverage` therefore needs no preference flag of its own:
when the preference is off, `exclSpecial === inclSpecial` and the client suppresses the toggle.
`special` also counts expenses only, never income, for the same reason.

## Component 2 — `server/routes/analytics.js`

After the existing loop that rounds each month's figures, and before the response is assembled:

```js
const average = buildRunningAverage({ series, months: 6, currentYm: thisYm });
```

`average` joins `series`, `topCategories` and `mom` in the JSON. `thisYm` already exists in that
function.

This is **purely additive** — every existing consumer of `/api/analytics` keeps working unchanged.
No new Supabase query: the transactions needed are already fetched for the series.

Note that `Analytics.jsx` requests `months=24`, so the six-month window is applied by the lib, not
by the query string. That is deliberate — the page also renders 24 months of history.

## Component 3 — `client/src/components/AverageMonthCard.jsx`

Rendered at the top of `client/src/pages/Analytics.jsx`, above the existing This month / Last month
/ Change card. Returns `null` when `average` is `null`.

```
┌─ Average month · last 6 completed ──────────────┐
│  £1,240                      [ incl. special ]  │
│  Feb–Jul 2026 · this month so far £410          │
└─────────────────────────────────────────────────┘
```

- **Heading** names the window honestly using `monthsUsed`: "last 6 completed" / "last 3 completed".
- **Figure** is `inclSpecial` or `exclSpecial` depending on the toggle, through `formatMoney` with
  the user's currency, matching the rest of the page.
- **Toggle** is a pill button matching the Dashboard hero's behaviour and styling
  (`client/src/pages/Dashboard.jsx:143-152`): `aria-pressed`, `incl. special` / `excl. special`.
  It is rendered **only when `inclSpecial !== exclSpecial`** — i.e. when there is special spend in
  the window — the same "only offer the toggle when it does something" rule the hero uses.
- **Sub-line** shows the window and `thisMonthSoFar` for comparison. The window label is built from
  `from` and `to`, printing the year once when they share one and twice when they do not:
  `Feb–Jul 2026`, `Sep 2025–Feb 2026`. When `monthsUsed === 1` it collapses to a single month,
  `Jul 2026`, rather than repeating it either side of a dash.

**Toggle memory.** `localStorage` key `trim:avgIncludeSpecial`, defaulting to including, wrapped in
try/catch exactly as `readIncludeSpecial()` in `Dashboard.jsx:91` is — private browsing must not
throw. This is a **separate** key from the hero's `trim:heroIncludeSpecial` by design: the hero
toggles *this month's net*, this toggles *a six-month expense average*, and flipping one should not
silently change the other page.

## Testing

`server/test/runningAverage.test.js`, `node --test`, following `server/test/overallBudget.test.js`:

1. Six full completed months plus a part-month → correct mean; the part-month is excluded.
2. `thisMonthSoFar` reports the current month even though it is excluded from the mean.
3. Only three completed months → mean over 3, `monthsUsed === 3`.
4. No completed months → `null`.
5. Leading pre-signup zero months are trimmed and do not dilute the mean.
6. A zero month *inside* the history is included and pulls the mean down.
7. Special present → `exclSpecial` is lower than `inclSpecial` by the right amount.
8. Preference off (all `special` are 0) → the two figures are equal.
9. More than 6 completed months → only the last 6 are used.
10. Exactly one completed month → `monthsUsed === 1`, `from === to`, and the mean equals that
    month's expenses.

## Definition of done

Per `CLAUDE.md`:

1. `npm test` passes in `server/`; `npm run build` passes in `client/`; the server starts cleanly.
2. The card is **reachable in the running app** — open Analytics, see it at the top, flip the
   toggle and watch the number change.
3. `FEATURES.md` and `BUILD_PLAN.md` updated in the same session. `SECURITY.md` is untouched: no
   change to auth, RLS or data access.
4. Committed on `main`.

## Explicitly out of scope

- The Dashboard comparison line ("vs £1,240 avg"). Considered and not chosen.
- Making the window length configurable. Six is what was asked for.
- A per-category average, or an average of income or net.
- Any change to how special expenses are flagged, grouped or stored.
