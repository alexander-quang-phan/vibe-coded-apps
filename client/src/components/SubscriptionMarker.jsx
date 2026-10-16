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

function CandidateList({ title, rows, isTicked, onToggle, currency }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {rows.map((c) => (
        <label key={c.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={isTicked(c.id)}
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
 *   2. "Trim already logs this automatically" — a Repeat-this schedule has its note;
 *   3. "Trim already spots this as Spotify" — it has the note of a detected one;
 *   4. Monthly / Weekly / Yearly plus "other charges that look like this one".
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
  // Which offer Alex said "it's a different subscription" about (key + strength).
  const [differentFrom, setDifferentFrom] = useState(null);
  // Alex's answer to an offer, remembered WITH the offer it answers (key|kind):
  // 'attach' | 'back' | 'final'. Derived below, never reset by an effect.
  const [choice, setChoice] = useState({ offer: null, value: null });
  // Alex's own ticks and unticks (id -> boolean), laid over the server's pre-ticks.
  const [tickOverrides, setTickOverrides] = useState(() => new Map());

  // Debounce a STRING: the parent passes a fresh `values` object every render, which
  // would restart the timer each time. `settled` is false while the panel is still
  // showing the answer for older values — Save must not apply that stale action.
  const valuesKey = values ? JSON.stringify(values) : null;
  const debouncedKey = useDebounced(valuesKey);
  const debounced = useMemo(() => (debouncedKey ? JSON.parse(debouncedKey) : null), [debouncedKey]);
  const settled = valuesKey === debouncedKey;

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
  const repeating = data?.repeating ?? null;
  const detected = data?.detected ?? null;
  const exact = existing?.strength === 'exact';
  // "It's a different subscription" only ever applies to a WEAK resemblance, and only
  // to the offer it was said about — an exact note always offers the existing one.
  // Compared, not reset by an effect: a refetch briefly empties `data`, and an effect
  // would wipe the answer every time Alex picks a cadence.
  const offerId = existing ? `${existing.merchantKey}|${existing.strength}` : null;
  const different = !exact && offerId !== null && offerId === differentFrom;
  // An exact tracked note wins; then a note Trim already logs (Repeat-this) beats a
  // weak look-alike (the server withholds that offer too — this is belt and braces).
  const mode = existing && exact
    ? 'existing'
    : repeating ? 'repeating' : existing && !different ? 'existing' : detected && !existing ? 'detected' : 'track';

  // "Likely" charges start ticked; Alex's own ticks/unticks win, and survive refetches
  // (a refetch empties `data` first — an effect keyed on it would wipe them).
  const likelyIds = useMemo(() => new Set((data?.likely ?? []).map((c) => c.id)), [data]);
  const isTicked = (id) => (tickOverrides.has(id) ? tickOverrides.get(id) : likelyIds.has(id));
  const toggleTick = (id) => setTickOverrides((prev) => new Map(prev).set(id, !isTicked(id)));

  // A plain "Add to …" is the one obvious choice, so it starts selected; a charge
  // after a cancellation must be answered (final charge, or is it back?).
  const choiceOffer = existing ? `${existing.merchantKey}|${existing.kind}` : null;
  const existingChoice = choiceOffer && choice.offer === choiceOffer
    ? choice.value
    : existing?.kind === 'attach' ? 'attach' : null;
  const setExistingChoice = (value) => setChoice({ offer: choiceOffer, value });

  const label = existing ? subscriptionLabel(existing, currency) : null;

  useEffect(() => {
    if (!data || !settled) return onActionChange(null);
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
    if (mode === 'detected' || mode === 'repeating') return onActionChange(NO_ACTION);
    if (!cadence) return onActionChange(null);
    // Only charges still on screen: a ticked one that dropped off the lists (the note
    // or amount changed) must not be linked behind Alex's back.
    const shown = [...(data.likely ?? []), ...(data.maybe ?? [])].map((c) => c.id);
    return onActionChange({ type: 'track', interval: cadence, includeIds: shown.filter(isTicked) });
    // onActionChange is the parent's setState; stable enough for this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, settled, mode, existingChoice, cadence, tickOverrides, label]);

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
    return (
      <div className="space-y-1.5">
        <p className="text-sm text-amber-600 dark:text-amber-400">Give it a category first — then it can be a subscription.</p>
        {!noteEditable && onChangeNote ? (
          <button type="button" onClick={onChangeNote} className="text-xs font-medium text-primary hover:underline">
            Set its category in Transactions
          </button>
        ) : null}
      </div>
    );
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
            {existing.cancelled ? <span className="text-muted-foreground"> (cancelled)</span> : null}
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
            onClick={() => setDifferentFrom(offerId)}
            className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            It's a different subscription
          </button>
        )}
      </div>
    );
  }

  if (mode === 'repeating') {
    const repLabel = subscriptionLabel(repeating, currency);
    return (
      <div className="space-y-1.5 text-sm">
        <p>
          <Repeat className="mr-1 inline h-3.5 w-3.5 text-primary" aria-hidden />
          Trim already logs this automatically as <span className="font-medium">{repLabel}</span>.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {onDetected ? (
            <button type="button" onClick={() => onDetected(repeating)} className="text-xs font-medium text-primary hover:underline">
              It's already on this page
            </button>
          ) : (
            <Link to="/subscriptions" className="text-xs font-medium text-primary hover:underline">
              Manage it on Subscriptions
            </Link>
          )}
          {changeNoteHint}
        </div>
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
            isTicked={isTicked}
            onToggle={toggleTick}
            currency={currency}
          />
          <CandidateList
            title="Maybe these too?"
            rows={data?.maybe ?? []}
            isTicked={isTicked}
            onToggle={toggleTick}
            currency={currency}
          />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">How often is it charged?</p>
      )}
    </div>
  );
}
