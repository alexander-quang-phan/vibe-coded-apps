import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Repeat } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/useApi';
import { formatMoney, formatDate } from '@/lib/format';
import { subscriptionLabel } from '@/lib/subscriptions';
import { cn } from '@/lib/utils';
import { NO_ACTION } from '@/lib/subscriptionActions';

const CADENCES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'annual', label: 'Yearly' },
];

/** Wait until the user stops typing before asking the server again. */
function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Choice({ selected, onSelect, children }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors',
        selected
          ? 'border-primary/60 bg-primary/10 text-foreground'
          : 'border-border/60 bg-background/40 text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function CandidateList({ title, rows, ticked, onToggle, currency }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {rows.map((c) => (
        <label key={c.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={ticked.has(c.id)}
            onChange={() => onToggle(c.id)}
          />
          <span className="min-w-0 flex-1 truncate">{c.description || 'No note'}</span>
          <span className="text-xs text-muted-foreground">{formatDate(c.date)}</span>
          <span className="nums text-xs font-medium">{formatMoney(c.amount, currency)}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * "This is a subscription" — the shared marking panel (Phase 17).
 *
 * Asks the server what marking this expense would mean, using the values as they
 * are CURRENTLY typed (the Edit dialog passes them in `values`), then offers, in
 * order of precedence:
 *   1. "Add to Netflix?" — it looks like a subscription you already track;
 *   2. "Trim already spots this as Spotify" — it has the note of a detected one;
 *   3. Monthly / Weekly / Yearly plus "other charges that look like this one".
 * An EXACT note match has no "it's a different subscription" escape: two
 * subscriptions with identical notes are treated as one, so the way out is to
 * change the note. A weaker resemblance always lets Alex say it's different.
 *
 * Controlled: reports the chosen action through `onActionChange` (see
 * lib/subscriptionActions.js); the parent applies it on Save / Track it.
 */
export function SubscriptionMarker({
  transactionId,
  values,
  currency,
  onActionChange,
  noteEditable = true,
  onChangeNote,
  onDetected,
}) {
  const api = useApi();
  const [cadence, setCadence] = useState(null);
  const [different, setDifferent] = useState(false);
  const [existingChoice, setExistingChoice] = useState(null); // 'attach' | 'back' | 'final'
  const [ticked, setTicked] = useState(() => new Set());

  const debounced = useDebounced(values ?? null);

  const url = useMemo(() => {
    const p = new URLSearchParams({ transactionId });
    if (debounced) {
      if (debounced.description !== undefined) p.set('description', debounced.description ?? '');
      if (debounced.categoryId) p.set('categoryId', debounced.categoryId);
      if (Number(debounced.amount) > 0) p.set('amount', String(debounced.amount));
      if (debounced.date) p.set('date', debounced.date);
    }
    if (cadence) p.set('interval', cadence);
    return `/api/subscriptions/track/preview?${p.toString()}`;
  }, [transactionId, debounced, cadence]);

  const { data, isLoading, isError, refetch } = useQuery({
    // Under 'subscriptions', so invalidateMoney() refreshes it after any change.
    queryKey: ['subscriptions', 'preview', url],
    queryFn: () => api.get(url),
    retry: false,
  });

  const existing = data?.existing ?? null;
  const detected = data?.detected ?? null;
  const exact = existing?.strength === 'exact';
  const mode = existing && !different ? 'existing' : detected && !existing ? 'detected' : 'track';

  // Pre-tick the "likely" charges each time the list changes.
  const likelyKey = (data?.likely ?? []).map((c) => c.id).join(',');
  useEffect(() => {
    setTicked(new Set(likelyKey ? likelyKey.split(',') : []));
  }, [likelyKey]);

  // A plain "Add to …" is the one obvious choice, so it starts selected; a charge
  // after a cancellation must be answered (final charge, or is it back?).
  useEffect(() => {
    setExistingChoice(existing?.kind === 'attach' ? 'attach' : null);
  }, [existing?.merchantKey, existing?.kind]);

  const label = existing ? subscriptionLabel(existing, currency) : null;

  useEffect(() => {
    if (!data) return onActionChange(null);
    if (data.needsCategory) return onActionChange(NO_ACTION);
    if (mode === 'existing') {
      if (!existingChoice) return onActionChange(null);
      return onActionChange({
        type: 'attach',
        merchantKey: existing.merchantKey,
        reactivate: existingChoice === 'back',
        label,
      });
    }
    if (mode === 'detected') return onActionChange(NO_ACTION);
    return onActionChange(cadence ? { type: 'track', interval: cadence, includeIds: [...ticked] } : null);
    // onActionChange is the parent's setState; stable enough for this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mode, existingChoice, cadence, ticked, label]);

  if (isLoading) return <Skeleton className="h-16" />;
  if (isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't check your subscriptions.{' '}
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => refetch()}>
          Try again
        </button>
      </p>
    );
  }
  if (data?.needsCategory) {
    return <p className="text-sm text-amber-600 dark:text-amber-400">Give it a category first — then it can be a subscription.</p>;
  }

  const changeNoteHint = noteEditable ? (
    <p className="text-xs text-muted-foreground">To keep them separate, give this expense a different note above.</p>
  ) : onChangeNote ? (
    <button type="button" onClick={onChangeNote} className="text-xs font-medium text-primary hover:underline">
      Change its note in Transactions
    </button>
  ) : null;

  if (mode === 'existing') {
    return (
      <div className="space-y-2">
        {existing.kind === 'attach' ? (
          <Choice selected={existingChoice === 'attach'} onSelect={() => setExistingChoice('attach')}>
            Add to <span className="font-medium text-foreground">{label}</span>
          </Choice>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              A {label} charge after you cancelled it:
            </p>
            <Choice selected={existingChoice === 'final'} onSelect={() => setExistingChoice('final')}>
              It's the final charge for <span className="font-medium text-foreground">{label}</span>
            </Choice>
            <Choice selected={existingChoice === 'back'} onSelect={() => setExistingChoice('back')}>
              <span className="font-medium text-foreground">{label}</span> is back — mark it active
            </Choice>
          </>
        )}
        {exact ? changeNoteHint : (
          <button
            type="button"
            onClick={() => setDifferent(true)}
            className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            It's a different subscription
          </button>
        )}
      </div>
    );
  }

  if (mode === 'detected') {
    const detLabel = subscriptionLabel(detected, currency);
    return (
      <div className="space-y-1.5 text-sm">
        <p>
          <Repeat className="mr-1 inline h-3.5 w-3.5 text-primary" aria-hidden />
          Trim already spots this as <span className="font-medium">{detLabel}</span>.
        </p>
        {onDetected ? (
          <button type="button" onClick={() => onDetected(detected)} className="text-xs font-medium text-primary hover:underline">
            It's already on this page
          </button>
        ) : (
          <Link to="/subscriptions" className="text-xs font-medium text-primary hover:underline">
            See it on Subscriptions
          </Link>
        )}
        {changeNoteHint}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="radiogroup" aria-label="How often is it charged?">
        {CADENCES.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={cadence === c.value}
            onClick={() => setCadence(c.value)}
            className={cn(
              'flex-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              cadence === c.value
                ? 'border-primary/60 bg-primary/10 text-primary'
                : 'border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      {cadence ? (
        <>
          <CandidateList
            title="Other charges that look like this one"
            rows={data?.likely ?? []}
            ticked={ticked}
            onToggle={(id) => setTicked((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })}
            currency={currency}
          />
          <CandidateList
            title="Maybe these too?"
            rows={data?.maybe ?? []}
            ticked={ticked}
            onToggle={(id) => setTicked((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })}
            currency={currency}
          />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">How often is it charged?</p>
      )}
    </div>
  );
}
