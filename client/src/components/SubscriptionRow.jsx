import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatMoney, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export function SubscriptionRow({ subscription, currency, onToggle, pending }) {
  const sub = subscription;
  const cancelled = sub.status === 'cancelled';
  const cat = sub.category;
  const cadenceLabel = sub.cadence === 'annual' ? 'Annual' : 'Monthly';

  return (
    <Card className={cn(cancelled && 'opacity-70')}>
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl"
            style={{ backgroundColor: `${cat?.color ?? '#64748b'}22` }}
            aria-hidden
          >
            {cat?.icon ?? '🔁'}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold leading-tight">{sub.name}</h3>
              <span className="rounded-full border border-border/60 bg-secondary/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {cadenceLabel}
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {cat?.name ?? 'Uncategorised'} · {sub.occurrences} charges so far
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <Stat label="Per month" value={formatMoney(sub.monthlyCost, currency)} emphasis />
          <Stat label="Per year" value={formatMoney(sub.annualCost, currency)} />
          <Stat label="Last charged" value={formatDate(sub.lastCharged)} />
          <Stat
            label={cancelled ? 'Was due' : 'Next expected'}
            value={formatDate(sub.nextExpected)}
          />
        </div>

        <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-center">
          <p className="text-xs text-muted-foreground">
            Total paid:{' '}
            <span className="font-medium text-foreground tabular-nums">
              {formatMoney(sub.totalPaid, currency)}
            </span>
          </p>
          <Button
            variant={cancelled ? 'outline' : 'secondary'}
            size="sm"
            disabled={pending}
            onClick={() => onToggle(sub, cancelled ? 'active' : 'cancelled')}
          >
            {pending
              ? 'Saving…'
              : cancelled
                ? 'Mark active'
                : 'Mark cancelled'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, emphasis }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          'truncate tabular-nums',
          emphasis ? 'text-sm font-semibold' : 'text-sm',
        )}
      >
        {value}
      </p>
    </div>
  );
}
