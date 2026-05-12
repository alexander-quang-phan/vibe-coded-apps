import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMoney, formatDate } from '@/lib/format';
import { subscriptionLabel, shouldShowRename } from '@/lib/subscriptions';
import { cn } from '@/lib/utils';

export function SubscriptionRow({ subscription, currency, onToggle, onRename, pending }) {
  const sub = subscription;
  const cancelled = sub.status === 'cancelled';
  const dismissed = sub.status === 'dismissed';
  const inactive = cancelled || dismissed;
  const cat = sub.category;
  const cadenceLabel = sub.cadence === 'annual' ? 'Annual' : 'Monthly';
  const label = subscriptionLabel(sub, currency);
  const showRename = shouldShowRename(sub) && !dismissed;

  let primaryAction;
  if (cancelled) {
    primaryAction = { label: 'Mark active', next: 'active', variant: 'outline' };
  } else if (dismissed) {
    primaryAction = { label: 'Restore', next: 'active', variant: 'outline' };
  } else {
    primaryAction = { label: 'Mark cancelled', next: 'cancelled', variant: 'secondary' };
  }

  return (
    <Card className={cn(inactive && 'opacity-70')}>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
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
                <h3 className="truncate text-base font-semibold leading-tight">{label}</h3>
                <span className="rounded-full border border-border/60 bg-secondary/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {cadenceLabel}
                </span>
                {sub.inferred && !sub.displayName ? (
                  <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                    Inferred
                  </span>
                ) : null}
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
              label={inactive ? 'Was due' : 'Next expected'}
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
            <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
              <Button
                variant={primaryAction.variant}
                size="sm"
                disabled={pending}
                onClick={() => onToggle(sub, primaryAction.next)}
              >
                {pending ? 'Saving…' : primaryAction.label}
              </Button>
              {sub.inferred && !inactive ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onToggle(sub, 'dismissed')}
                  className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  Not a subscription
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {showRename ? (
          <RenameForm sub={sub} onRename={onRename} pending={pending} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RenameForm({ sub, onRename, pending }) {
  const [value, setValue] = useState(sub.displayName ?? '');

  useEffect(() => {
    setValue(sub.displayName ?? '');
  }, [sub.displayName, sub.merchantKey]);

  const trimmed = value.trim();
  const current = sub.displayName ?? '';
  const dirty = trimmed !== current;
  const placeholder = sub.inferred
    ? 'Name this — e.g. Netflix'
    : 'Give this a custom name';

  function handleSubmit(e) {
    e.preventDefault();
    if (!dirty || pending) return;
    onRename(sub, trimmed.length === 0 ? null : trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 border-t border-border/60 pt-3"
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        maxLength={40}
        className="h-9 text-sm"
        disabled={pending}
        aria-label={`Name for ${sub.merchantKey}`}
      />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={pending || !dirty}
      >
        {pending ? 'Saving…' : sub.displayName ? 'Update' : 'Save name'}
      </Button>
    </form>
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
