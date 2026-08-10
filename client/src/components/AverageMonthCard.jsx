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

/**
 * What a normal month costs, over the last N COMPLETED months. The month in
 * progress is shown alongside for comparison but never averaged in — see
 * server/lib/runningAverage.js for why.
 */
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
