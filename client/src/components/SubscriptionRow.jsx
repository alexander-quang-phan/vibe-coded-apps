import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MoneyInput, isValidMoney, sanitizeMoneyInput } from '@/components/ui/money-input';
import { formatMoney, formatDate } from '@/lib/format';
import { subscriptionLabel, cadenceLabel as cadenceLabelFor } from '@/lib/subscriptions';
import { cn } from '@/lib/utils';

export function SubscriptionRow({ subscription, currency, onToggle, onRename, onEditAmount, pending }) {
  const sub = subscription;
  const cancelled = sub.status === 'cancelled';
  const dismissed = sub.status === 'dismissed';
  const inactive = cancelled || dismissed;
  const cat = sub.category;
  const cadenceLabel = cadenceLabelFor(sub.cadence);
  const label = subscriptionLabel(sub, currency);

  // Task 6.12b — rows the user marked recurring themselves, rather than ones
  // the detector inferred. The server REJECTS two of the actions below for
  // these keys, so they must not be offered:
  //   • displayName  — manualPatchSchema has no such field (400)
  //   • 'dismissed'  — 400 "cannot be dismissed — cancel it instead"
  // In exchange they gain an amount edit, which detected rows can't have.
  const manual = sub.source === 'manual';

  // Unnamed inferred rows open the rename form by default — naming them is
  // the whole point (Task 6.2.1). Everything else gets a quiet Rename button.
  const needsName = sub.inferred && !sub.displayName;
  const [renaming, setRenaming] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);
  const showRenameForm = !manual && !dismissed && (needsName || renaming);

  let primaryAction;
  if (cancelled) {
    primaryAction = { label: 'Mark active', next: 'active', variant: 'outline' };
  } else if (dismissed) {
    primaryAction = { label: 'Restore', next: 'active', variant: 'outline' };
  } else {
    primaryAction = { label: 'Mark cancelled', next: 'cancelled', variant: 'secondary' };
  }

  return (
    <Card className={cn('border-border/60 bg-card/70 backdrop-blur', inactive && 'opacity-70')}>
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
                {manual ? (
                  <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">
                    Manually marked
                  </span>
                ) : null}
                {needsName ? (
                  <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                    Inferred
                  </span>
                ) : null}
                {manual && !editingAmount && !cancelled ? (
                  <button
                    type="button"
                    onClick={() => setEditingAmount(true)}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={`Edit amount for ${label}`}
                  >
                    <Pencil className="h-3 w-3" aria-hidden />
                    Edit amount
                  </button>
                ) : null}
                {!manual && !showRenameForm && !dismissed ? (
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={`Rename ${label}`}
                  >
                    <Pencil className="h-3 w-3" aria-hidden />
                    Rename
                  </button>
                ) : null}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {cat?.name ?? 'Uncategorised'} ·{' '}
                {sub.occurrences === 1 ? '1 charge so far' : `${sub.occurrences} charges so far`}
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
              {/* Manual rows have no "dismissed" state — the user opted in
                  deliberately, so cancel is the correct off-ramp and the
                  server 400s a dismiss. */}
              {!inactive && !manual ? (
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

        {showRenameForm ? (
          <RenameForm
            sub={sub}
            onRename={onRename}
            pending={pending}
            onDone={() => setRenaming(false)}
          />
        ) : null}

        {editingAmount ? (
          <AmountForm
            sub={sub}
            currency={currency}
            onEditAmount={onEditAmount}
            pending={pending}
            onDone={() => setEditingAmount(false)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RenameForm({ sub, onRename, pending, onDone }) {
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
    onDone();
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
        autoFocus={!sub.inferred}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !dirty}>
        {pending ? 'Saving…' : sub.displayName ? 'Update' : 'Save name'}
      </Button>
      {!sub.inferred || sub.displayName ? (
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      ) : null}
    </form>
  );
}

/**
 * Task 6.12b — edit a manually-marked recurrence's amount. Future instances
 * only: transactions already created keep the amount they were logged with and
 * are never rewritten, so the history stays honest.
 */
function AmountForm({ sub, currency, onEditAmount, pending, onDone }) {
  const [value, setValue] = useState(() => sanitizeMoneyInput(String(sub.amount), currency));

  useEffect(() => {
    setValue(sanitizeMoneyInput(String(sub.amount), currency));
  }, [sub.amount, sub.merchantKey, currency]);

  const dirty = isValidMoney(value) && Number(value) !== Number(sub.amount);

  function handleSubmit(e) {
    e.preventDefault();
    if (!dirty || pending) return;
    onEditAmount(sub, Number(value));
    onDone();
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-border/60 pt-3">
      <div className="flex items-center gap-2">
        <MoneyInput
          value={value}
          onValueChange={setValue}
          currency={currency}
          showSymbol
          containerClassName="w-36"
          className="no-spin h-9 text-sm"
          disabled={pending}
          aria-label={`Amount for ${subscriptionLabel(sub, currency)}`}
          autoFocus
        />
        <Button type="submit" size="sm" variant="secondary" disabled={pending || !dirty}>
          {pending ? 'Saving…' : 'Update'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Applies to future charges only — what you've already logged stays as it was.
      </p>
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
