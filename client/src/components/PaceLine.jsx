import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The budget-pace line (Task 9.3, extended in Phase 10 A4).
 *
 * Previously this JSX was duplicated byte-for-byte in AffordabilityCheck and
 * SimpleMonthCard, so every wording change had to be made twice.
 *
 * Phase 10 adds the two numbers Alex asked for: how far off pace you are right
 * now, and what you can spend per day for the rest of the month. Three states:
 *
 *   under pace        ✓ …you're at X, £Y under. £Z/day for the N days left.
 *   over pace         ◷ …you're at X, £Y over where you'd normally be. £Z/day…
 *   over BUDGET       ◷ You're £Y over your £B budget — nothing left for…
 *
 * Tone stays amber, never red, never scolding — the existing convention.
 * `perDayLeft` is floored at 0 server-side, so an over-budget month reports the
 * overage instead of a meaningless negative daily allowance.
 */
export function PaceLine({ pace, daysElapsed, currency, className }) {
  if (!pace) return null;

  const overBudget = pace.overBy > 0;
  const aheadOfPace = pace.delta < 0; // spending faster than the flat run-rate
  const tone = overBudget || aheadOfPace ? 'text-amber-400' : 'text-primary';
  const dayWord = pace.daysRemaining === 1 ? 'day' : 'days';

  if (overBudget) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        <span className="text-amber-400">◷</span>{' '}
        You're{' '}
        <span className="nums font-medium text-amber-400">
          {formatMoney(pace.overBy, currency)}
        </span>{' '}
        over your {formatMoney(pace.budget, currency)} budget — nothing left for the last{' '}
        {pace.daysRemaining} {dayWord}.
      </p>
    );
  }

  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      <span className={tone}>{aheadOfPace ? '◷' : '✓'}</span>{' '}
      By day {daysElapsed}, about {formatMoney(pace.target, currency)} of your budget would
      typically be used — you're at{' '}
      <span className={cn('nums font-medium', tone)}>{formatMoney(pace.spent, currency)}</span>,{' '}
      <span className={cn('nums font-medium', tone)}>
        {formatMoney(Math.abs(pace.delta), currency)}
      </span>{' '}
      {aheadOfPace ? 'over where you’d normally be' : 'under'}. That's{' '}
      <span className="nums font-medium text-foreground">
        {formatMoney(pace.perDayLeft, currency)}
      </span>
      /day for the {pace.daysRemaining} {dayWord} left.
    </p>
  );
}
