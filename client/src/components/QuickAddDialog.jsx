import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, Sparkles, ArrowLeft, Loader2, Star, Repeat } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MoneyInput, isValidMoney } from '@/components/ui/money-input';
import { CurrencyPicker, ConversionLine } from '@/components/CurrencyEntry';
import { SpecialGroupPicker } from '@/components/SpecialGroupPicker';
import { TripPicker } from '@/components/TripPicker';
import { TripTag } from '@/components/TripTag';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { SegmentGroup, SegmentButton } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/useApi';
import { useTrips } from '@/hooks/useTrips';
import { cn } from '@/lib/utils';
import { todayISO } from '@/lib/format';
import { invalidateMoney } from '@/lib/invalidate';
import {
  tagFor, tripSubmitFields, seedCurrency, mayRevertCurrency, recallRate, rememberRate,
} from '@/lib/trips';
import { subscriptionLabel } from '@/lib/subscriptions';
import { runSubscriptionAction, subscriptionActionMessage } from '@/lib/subscriptionActions';
import {
  celebrateLevelUp,
  celebrateStreakMilestone,
  celebrateShieldEarned,
} from '@/lib/confetti';

function minorToMajorStr(minor, currency) {
  if (!Number.isFinite(minor)) return '';
  const major = currency === 'VND' ? minor : minor / 100;
  return currency === 'VND' ? String(major) : major.toFixed(2);
}

export function QuickAddDialog({
  open,
  onOpenChange,
  currency = 'GBP',
  simpleMode = false,
  specialEnabled = false,
  // Opens the dialog pre-dated to another month. Used by the Analytics average
  // card to backfill a month with nothing logged. Left undefined it means today,
  // read when the dialog OPENS. A `= todayISO()` default here changed value at
  // midnight, which re-ran the reset below under an open dialog: the keystroke was
  // wiped, and a foreign entry was left holding a rate of 1 (BUGS-FIXED 2026-11-03).
  initialDate,
  // Phase 18: opened from a trip's own page. Attached whatever the date; only ✕ or the
  // chooser removes it, so a March flight can be logged from the trip it belongs to.
  presetTripId = null,
}) {
  const api = useApi();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState('structured');
  const [type, setType] = useState('expense');
  const [amountStr, setAmountStr] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(initialDate ?? todayISO());
  const [showMore, setShowMore] = useState(false);
  const [freeformText, setFreeformText] = useState('');
  const [parseError, setParseError] = useState(null);
  const [suggestedCategoryId, setSuggestedCategoryId] = useState(null);
  // Phase 10 (A2): a category chip must be tapped TWICE. The first tap only
  // arms it — a misdirected thumb can no longer log an expense to the wrong
  // category, which was the whole complaint.
  const [armedCategoryId, setArmedCategoryId] = useState(null);
  const [isSpecial, setIsSpecial] = useState(false);
  // Task 6.12b — opt this expense into a recurring schedule. Expense-only
  // (the server 400s "Only expenses can be recurring"), and it lives in the
  // advanced area so the two-tap path never grows a step.
  const [recurringInterval, setRecurringInterval] = useState(null); // null | 'monthly' | 'weekly'
  const [specialGroupId, setSpecialGroupId] = useState(null); // Phase 10 B1, optional
  // Phase 12 — foreign currency. `entryCurrency` is what the user typed in;
  // `currency` (the prop) stays their base, which is what gets stored.
  const [entryCurrency, setEntryCurrency] = useState(currency);
  const [rate, setRate] = useState('1');
  const [rateState, setRateState] = useState('idle'); // idle | loading | ready | unavailable
  // Phase 18 — trip mode. The tag is DERIVED from these, never stored: a refetch can't
  // wipe a choice (BUGS-FIXED shape 8). `tripChoice` is what Alex did by hand in this
  // entry; the reset below clears it, so a ✕ applies to one entry, not the session.
  const [tripChoice, setTripChoice] = useState(null);
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [currencyDeclined, setCurrencyDeclined] = useState(false);
  const [rememberedOn, setRememberedOn] = useState(null); // the date of a remembered rate in use
  // Bumped by every reset, so the rate effect always runs again after one, even when the
  // currency it depends on comes out the same.
  const [resetCount, setResetCount] = useState(0);
  const amountRef = useRef(null);
  const freeformRef = useRef(null);
  // The reset and the effects after it run in one commit and share one render's closure,
  // so an effect in that commit would read the previous entry's amount and flags.
  const justReset = useRef(false);
  const skipStaleRate = useRef(false);
  // For what happens later than the render that started it: a rate that fails after
  // Alex has typed must see what he typed, or £4,500 forints (the Phase 12 bug class).
  const latest = useRef({});

  const { data: tripsData, isLoading: tripsLoading, isError: tripsFailed } = useTrips();
  const trips = tripsData?.trips;
  const tag = useMemo(
    () => tagFor({ trips, date, type, presetTripId, choice: tripChoice }),
    [trips, date, type, presetTripId, tripChoice],
  );
  const attached = !!tag;
  latest.current = {
    amountTyped: amountStr !== '',
    armed: armedCategoryId !== null,
    currencyTouched,
    stopCurrency: tag?.stop?.currency ?? null,
    rateTouched: latest.current.rateTouched ?? false,
  };

  useEffect(() => {
    if (open) {
      setMode('structured');
      setType('expense');
      setAmountStr('');
      setDescription('');
      const openDate = initialDate ?? todayISO();
      setDate(openDate);
      // Auto-open the advanced section when the date is not today, so a pre-dated
      // add is never invisible. Same rule as the AI parser below, which already
      // does this when it moves the date off today.
      setShowMore(openDate !== todayISO());
      setFreeformText('');
      setParseError(null);
      setSuggestedCategoryId(null);
      setArmedCategoryId(null);
      setIsSpecial(false);
      setRecurringInterval(null);
      setSpecialGroupId(null);
      setTripChoice(null);
      setCurrencyTouched(false);
      setCurrencyDeclined(false);
      setRememberedOn(null);
      // Seeded here, from the freshly reset values. Read from the cache, not `trips`, so
      // this effect is never keyed on query data.
      const seedTag = tagFor({
        trips: queryClient.getQueryData(['trips'])?.trips,
        date: openDate,
        type: 'expense',
        presetTripId,
      });
      const seeded = seedCurrency({ stop: seedTag?.stop, base: currency }) ?? currency;
      setEntryCurrency(seeded);
      justReset.current = true;
      skipStaleRate.current = true;
      latest.current = {
        amountTyped: false,
        armed: false,
        currencyTouched: false,
        stopCurrency: seedTag?.stop?.currency ?? null,
        rateTouched: false,
      };
      // A rate of 1 is only ever true of the home currency. It passes the rate gate, so
      // leaving it under a foreign currency would log 4,500 forints as £4,500.
      setRate(seeded === currency ? '1' : '');
      setRateState(seeded === currency ? 'idle' : 'loading');
      setResetCount((n) => n + 1);
      setTimeout(() => amountRef.current?.focus(), 80);
    }
  }, [open, initialDate, currency, presetTripId, queryClient]);

  // Later changes only: trip data arriving, the date moving, a tag chosen or cleared.
  // seedCurrency refuses under a typed amount, an armed chip or a picked currency.
  useEffect(() => {
    if (!open) return;
    if (justReset.current) {
      justReset.current = false;
      return;
    }
    const next = seedCurrency({
      stop: tag?.stop,
      base: currency,
      amountTyped: amountStr !== '',
      armed: armedCategoryId !== null,
      currencyTouched,
      declined: currencyDeclined,
    });
    if (next && next !== entryCurrency) setEntryCurrency(next);
  }, [open, tag, amountStr, armedCategoryId, currencyTouched, currencyDeclined, currency, entryCurrency]);

  // Phase 12 — fetch the day's rate whenever the entry currency changes to
  // something other than the user's own. Same currency short-circuits to 1
  // without a request. A failed or unquotable pair is not an error: rateState
  // goes 'unavailable' and the user types the rate themselves.
  const isForeign = entryCurrency !== currency;
  useEffect(() => {
    if (!open) return;
    // The commit the reset ran in still has the previous entry's currency in this closure.
    // resetCount has changed, so this runs again next commit with the right one.
    if (skipStaleRate.current) {
      skipStaleRate.current = false;
      return;
    }
    if (!isForeign) {
      setRate('1');
      setRateState('idle');
      return;
    }
    let cancelled = false;
    latest.current.rateTouched = false;
    // Only a currency a stop seeded may use a remembered rate. One Alex picked by hand
    // keeps waiting for today's, so it can't log on a rate up to 30 days old.
    const seededByStop = !latest.current.currencyTouched && latest.current.stopCurrency === entryCurrency;
    const remembered = seededByStop ? recallRate(entryCurrency, currency, todayISO()) : null;
    if (remembered) {
      setRate(String(remembered.rate));
      setRateState('ready');
      setRememberedOn(remembered.date);
    } else {
      setRateState('loading');
      setRememberedOn(null);
      // Clear the old rate immediately. Leaving the previous currency's rate in
      // the box meant switching EUR -> SEK showed "No rate available" and
      // "Logs as £38.50" side by side, the second computed at the euro rate.
      setRate('');
    }
    const failed = () => {
      if (cancelled) return;
      // A remembered rate stays, and the currency never changes under it.
      if (remembered) return;
      if (!latest.current.currencyTouched && mayRevertCurrency(latest.current)) {
        // Nothing typed yet, so nothing can change meaning. `declined` stops the seeding
        // effect putting it straight back.
        setCurrencyDeclined(true);
        setEntryCurrency(currency);
        return;
      }
      setRateState('unavailable');
    };
    api
      .get(`/api/fx?from=${entryCurrency}&to=${currency}`)
      .then((r) => {
        if (cancelled) return;
        if (!(r && typeof r.rate === 'number' && r.rate > 0)) return failed();
        rememberRate(entryCurrency, currency, r.rate, r.date ?? todayISO());
        // Never swapped in behind an armed chip or a rate Alex typed: what he is about
        // to confirm must be what gets logged.
        if (remembered && (latest.current.armed || latest.current.rateTouched)) return;
        setRate(String(r.rate));
        setRateState('ready');
        setRememberedOn(null);
      })
      .catch(failed);
    return () => {
      cancelled = true;
    };
  }, [open, isForeign, entryCurrency, currency, api, resetCount]);

  useEffect(() => {
    if (mode === 'freeform') {
      setTimeout(() => freeformRef.current?.focus(), 80);
    }
  }, [mode]);

  const { data: categoriesData } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
    enabled: open,
  });

  // Task 6.9 — merchant memory. As the user types a note, ask the server
  // which category they usually file this merchant under and ring that chip.
  // Highlight-only: a wrong silent auto-pick is worse than a missed hint.
  useEffect(() => {
    if (!open || simpleMode || mode !== 'structured') return;
    const desc = description.trim();
    if (desc.length < 2) return;
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/api/categories/suggest?desc=${encodeURIComponent(desc)}`);
        if (res?.categoryId) setSuggestedCategoryId(res.categoryId);
      } catch {
        // Suggestions are a bonus — never surface an error for one.
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [description, open, simpleMode, mode, api]);

  const categories = useMemo(() => {
    const all = categoriesData?.categories ?? [];
    return all.filter((c) => c.type === type);
  }, [categoriesData, type]);

  const armedCategory = useMemo(
    () => categories.find((c) => c.id === armedCategoryId) ?? null,
    [categories, armedCategoryId],
  );

  const amount = Number(amountStr);
  const amountValid = isValidMoney(amountStr);

  // A foreign entry is only submittable once it has a usable rate. Without this
  // gate the amount field holds the FOREIGN number while foreignPayload() drops
  // the block, so the server — which has no way to know the entry currency —
  // stored the foreign figure verbatim as base currency: €45 logged as £45, and
  // far worse in a big-denomination currency. Number('') and Number('0.') are
  // both 0, so the empty and half-typed cases have to be caught here too.
  const fxRate = Number(rate);
  const rateValid = !isForeign || (rate !== '' && Number.isFinite(fxRate) && fxRate > 0);
  // Waits on the first load only. A failed trips query never blocks logging.
  const canSubmit = amountValid && rateValid && !tripsLoading;

  // Phase 17 — "Is this your Netflix subscription?" Asked, never assumed: Yes
  // attaches the charge, No (or ignoring it) leaves it alone. The answer runs after
  // this dialog has closed, so it uses only values captured here.
  function askAboutSubscription(match, transactionId) {
    const label = subscriptionLabel(match, currency);
    const attach = (reactivate) => {
      const action = { type: 'attach', merchantKey: match.merchantKey, reactivate, label };
      runSubscriptionAction(api, transactionId, action)
        .then((result) => {
          invalidateMoney(queryClient);
          const m = subscriptionActionMessage(action, result);
          toast.success(m.title, { description: m.description });
        })
        .catch((err) => toast.error(err?.message || "Couldn't add it to the subscription"));
    };
    if (match.kind === 'finalOrBack' && match.canReactivate === false) {
      // "It's back" would be refused: a Repeat-this schedule logs this note now.
      toast(`A ${label} charge after you cancelled it`, {
        description: 'Trim logs it automatically now. Add it as the final charge?',
        duration: 12000,
        action: { label: 'Final charge', onClick: () => attach(false) },
        cancel: { label: 'No', onClick: () => {} },
      });
    } else if (match.kind === 'finalOrBack') {
      toast(`A ${label} charge after you cancelled it`, {
        description: 'Is it back, or was this the final charge?',
        duration: 12000,
        action: { label: "It's back", onClick: () => attach(true) },
        cancel: { label: 'Final charge', onClick: () => attach(false) },
      });
    } else {
      toast(`Is this your ${label} subscription?`, {
        duration: 12000,
        action: { label: 'Yes', onClick: () => attach(false) },
        cancel: { label: 'No', onClick: () => {} },
      });
    }
  }

  const mutation = useMutation({
    mutationFn: (payload) => api.post('/api/transactions', payload),
    onSuccess: (res) => {
      invalidateMoney(queryClient);

      const d = res?.delta;
      if (d?.levelUp) {
        celebrateLevelUp();
        toast.success(`Level up! You're now ${d.newTitle}`, {
          description: `Level ${d.newLevel} · +${d.awardedXp} XP`,
        });
      } else if (d?.shieldEarned) {
        celebrateShieldEarned();
        toast.success('Streak shield earned 🛡️', {
          description: `Banked. You now have ${d.shields} — miss a day and we've got you.`,
        });
      } else if (d?.streakExtended && d.currentStreak > 1 && d.currentStreak % 7 === 0) {
        celebrateStreakMilestone();
        toast.success(`${d.currentStreak}-day streak! 🔥`);
      } else if (type === 'expense' && res?.recurrence) {
        toast.success(`Repeating ${res.recurrence.interval} 🔁`, {
          description: 'Manage it on Subscriptions.',
        });
      } else if (type === 'expense' && isSpecial && !res?.transaction?.trip_id) {
        toast.success('Logged as special ⭐', { description: 'Outside your monthly budget' });
      } else if (!res?.transaction?.trip_id) {
        toast.success('Logged', { description: `+${d?.awardedXp ?? 0} XP` });
      }

      // Outside the chain above, so a level-up can never swallow the way to undo a home
      // phone bill caught by trip mode.
      if (res?.transaction?.trip_id) {
        const txId = res.transaction.id;
        const name = trips?.find((t) => t.id === res.transaction.trip_id)?.name ?? 'your trip';
        toast.success(`Logged to ${name} ✈️`, {
          duration: 10000,
          action: {
            label: 'Not trip spending',
            onClick: () => {
              api
                .patch(`/api/transactions/${txId}`, { tripId: null })
                .then(() => {
                  invalidateMoney(queryClient);
                  toast.success('Taken off the trip');
                })
                .catch((err) => toast.error(err?.message || "Couldn't take it off the trip"));
            },
          },
        });
      }

      if (d?.shieldUsed) {
        toast('Streak shield used 🛡️', {
          description: 'You missed yesterday but we saved your streak.',
        });
      }

      // LAST, outside the else-if chain above, so a level-up or streak toast can
      // never swallow it, and it sits on top of the stack where its buttons show.
      if (res?.subscriptionMatch && res?.transaction?.id) {
        askAboutSubscription(res.subscriptionMatch, res.transaction.id);
      }

      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err?.message || 'Something went wrong');
    },
  });

  const parseMutation = useMutation({
    mutationFn: (text) => api.post('/api/transactions/parse', { text }),
    onSuccess: (res) => {
      const p = res?.parsed;
      if (!p) {
        setParseError("couldn't quite read that — mind trying again?");
        return;
      }
      const allCategories = categoriesData?.categories ?? [];
      const matched = p.categoryId
        ? allCategories.find((c) => c.id === p.categoryId)
        : null;
      const inferredType = matched?.type ?? 'expense';

      setType(inferredType);
      setAmountStr(minorToMajorStr(p.amount, p.currency));
      setDescription(p.description ?? '');
      setDate(p.occurredAt || todayISO());
      setSuggestedCategoryId(matched?.id ?? null);
      // Reveal advanced section only if AI moved the date — the note is now
      // always visible, so it no longer needs the disclosure opened for it.
      setShowMore(Boolean(p.occurredAt) && p.occurredAt !== todayISO());
      setArmedCategoryId(null);
      setParseError(null);
      setMode('structured');
    },
    onError: (err) => {
      const status = err?.status;
      if (status === 503) {
        setParseError("AI parsing isn't available right now — try the chips instead.");
      } else {
        setParseError("couldn't quite read that — mind trying again?");
      }
    },
  });

  function handleCategoryTap(category) {
    if (!canSubmit || mutation.isPending) return;
    // First tap on a chip only arms it; tapping a different chip moves the
    // (see foreignPayload below for the Phase 12 currency fields)
    // arm rather than logging. Only the second tap on the SAME chip commits.
    if (armedCategoryId !== category.id) {
      setArmedCategoryId(category.id);
      return;
    }
    mutation.mutate({
      categoryId: category.id,
      amount,
      type,
      description: description.trim() || null,
      date,
      // While a trip is attached these are hidden, so none of them is sent: the server
      // derives the star and clears any group. Sending isSpecial:false here would count
      // every trip expense in the monthly budget.
      ...(type === 'expense' && !attached ? { isSpecial } : {}),
      ...(type === 'expense' && !attached && isSpecial && specialGroupId ? { specialGroupId } : {}),
      ...(type === 'expense' && !attached && recurringInterval
        ? { recurring: { interval: recurringInterval } }
        : {}),
      ...tripSubmitFields(tag),
      ...foreignPayload(),
      // The streak belongs to the user's calendar day, not the server's UTC one.
      clientToday: todayISO(),
    });
  }

  /**
   * Phase 12 — the currency fields, only when the entry really is foreign.
   * `amount` still goes in the payload but the server IGNORES it whenever this
   * block is present and derives the stored figure itself, so the two can never
   * drift apart. Returns {} for the ordinary same-currency case.
   */
  function foreignPayload() {
    if (!isForeign) return {};
    // Unreachable: canSubmit already refuses a foreign entry without a valid
    // rate. Throwing rather than returning {} means that if the gate is ever
    // removed the failure is loud, instead of quietly logging the foreign
    // number as base currency the way this function used to.
    if (!rateValid) throw new Error('foreign entry submitted without a valid rate');
    return {
      foreign: { originalAmount: amount, originalCurrency: entryCurrency, fxRate },
    };
  }

  // Simple mode files everything against the seeded "Other" expense category
  // — the deliberate 2-tap exception to the 3-tap rule (FEATURES.md).
  function handleSimpleLog() {
    if (!canSubmit || mutation.isPending) return;
    const all = categoriesData?.categories ?? [];
    const fallback =
      all.find((c) => c.type === 'expense' && c.name === 'Other' && c.is_default) ??
      all.find((c) => c.type === 'expense');
    if (!fallback) return;
    mutation.mutate({
      categoryId: fallback.id,
      amount,
      type: 'expense',
      description: null,
      date,
      ...tripSubmitFields(tag),
      ...foreignPayload(),
      // The streak belongs to the user's calendar day, not the server's UTC one.
      clientToday: todayISO(),
    });
  }

  function handleParse() {
    const text = freeformText.trim();
    if (!text || parseMutation.isPending) return;
    setParseError(null);
    parseMutation.mutate(text);
  }

  function switchToFreeform() {
    setMode('freeform');
    setParseError(null);
  }

  function switchToStructured() {
    setMode('structured');
    setParseError(null);
  }

  const dateField = (
    <div className="space-y-1.5">
      <Label htmlFor="qa-date">Date</Label>
      <Input
        id="qa-date"
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Height cap + inner scrolling now live in DialogContent itself, so every
          dialog gets them — this used to be the only one that had them. */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a transaction</DialogTitle>
          <DialogDescription>
            {simpleMode
              ? 'Amount, then Log. Two taps and done.'
              : mode === 'freeform'
                ? 'Describe it in your own words — we’ll turn it into a draft.'
                : 'Amount, then tap a category twice to confirm.'}
          </DialogDescription>
        </DialogHeader>

        <div className={simpleMode ? 'hidden' : '-mt-1 flex justify-end'}>
          {mode === 'structured' ? (
            <button
              type="button"
              onClick={switchToFreeform}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Type it instead
            </button>
          ) : (
            <button
              type="button"
              onClick={switchToStructured}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Use chips
            </button>
          )}
        </div>

        {mode === 'freeform' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="qa-freeform">What happened?</Label>
              <Textarea
                id="qa-freeform"
                ref={freeformRef}
                rows={3}
                maxLength={500}
                placeholder="e.g. spent 12 quid on tacos last night"
                value={freeformText}
                onChange={(e) => {
                  setFreeformText(e.target.value);
                  if (parseError) setParseError(null);
                }}
                disabled={parseMutation.isPending}
              />
              {parseError ? (
                <p className="text-xs text-amber-500">{parseError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  We’ll draft the transaction — you confirm before it’s logged.
                </p>
              )}
            </div>
            <Button
              type="button"
              className="w-full"
              onClick={handleParse}
              disabled={!freeformText.trim() || parseMutation.isPending}
            >
              {parseMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Reading…
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" aria-hidden />
                  Draft it
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => onOpenChange(false)}
              disabled={parseMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <>
            {/* Phase 18: visible, with its own ✕. Hidden for income by tagFor. */}
            {tag ? <TripTag tag={tag} onChoose={setTripChoice} /> : null}
            {tripsFailed && !tripsData ? (
              <p className="text-xs text-muted-foreground">Couldn’t check your trips, so this logs as a normal expense.</p>
            ) : null}

            {/* Step 1: type (hidden in simple mode — everything is an expense) */}
            {simpleMode ? null : (
              <SegmentGroup className="self-start">
                <SegmentButton
                  active={type === 'expense'}
                  onClick={() => {
                    setType('expense');
                    setArmedCategoryId(null);
                  }}
                >
                  Expense
                </SegmentButton>
                <SegmentButton
                  active={type === 'income'}
                  onClick={() => {
                    setType('income');
                    setArmedCategoryId(null);
                  }}
                >
                  Income
                </SegmentButton>
              </SegmentGroup>
            )}

            {/* Step 2: amount */}
            <div className="space-y-2">
              <div className="flex items-end justify-between gap-2">
                <Label htmlFor="qa-amount">Amount</Label>
                {/* Phase 12. Defaults to the user's own currency, so the normal
                    two-tap path is untouched — this only does anything abroad. */}
                <CurrencyPicker
                  value={entryCurrency}
                  base={currency}
                  onChange={(c) => {
                    setCurrencyTouched(true);
                    setEntryCurrency(c);
                  }}
                />
              </div>
              <MoneyInput
                id="qa-amount"
                ref={amountRef}
                currency={entryCurrency}
                showSymbol
                symbolClassName="left-4 text-2xl"
                className="no-spin h-16 pl-10 text-3xl font-bold tracking-tight"
                value={amountStr}
                onValueChange={(v) => {
                  setAmountStr(v);
                  setArmedCategoryId(null);
                }}
              />
              {isForeign ? (
                <ConversionLine
                  amountStr={amountStr}
                  entryCurrency={entryCurrency}
                  baseCurrency={currency}
                  rate={rate}
                  rateState={rateState}
                  rememberedOn={rememberedOn}
                  onRateChange={(v) => {
                    latest.current.rateTouched = true;
                    setRate(v);
                  }}
                />
              ) : currencyDeclined && tag?.stop?.currency ? (
                <p className="text-xs text-muted-foreground">
                  Couldn’t get a {tag.stop.currency} rate, so this is in {currency}. Pick {tag.stop.currency} above to type a rate.
                </p>
              ) : null}
            </div>

            {/* Note — always visible (Phase 10 A2). It also feeds the merchant
                memory that rings a chip below, so it has to come first. */}
            <div className={simpleMode ? 'hidden' : 'space-y-1.5'}>
              <Label htmlFor="qa-desc">Note</Label>
              <Input
                id="qa-desc"
                type="text"
                placeholder="Optional (e.g. weekly shop)"
                value={description}
                maxLength={200}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Simple mode: one Log button instead of the chip grid */}
            {simpleMode ? (
              <Button
                type="button"
                className="h-12 w-full text-base font-semibold"
                onClick={handleSimpleLog}
                disabled={!canSubmit || mutation.isPending}
              >
                {mutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    Logging…
                  </>
                ) : (
                  'Log'
                )}
              </Button>
            ) : null}

            {/* Step 3: category chips — auto-submits on tap */}
            <div className={simpleMode ? 'hidden' : 'space-y-2'}>
              <Label>Category</Label>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {categories.map((c) => {
                  const isSuggested = c.id === suggestedCategoryId;
                  const isArmed = c.id === armedCategoryId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!canSubmit || mutation.isPending}
                      onClick={() => handleCategoryTap(c)}
                      aria-pressed={isArmed}
                      aria-label={isArmed ? `${c.name} — tap again to log` : c.name}
                      className={cn(
                        'group relative flex flex-col items-center gap-1.5 overflow-hidden rounded-xl border p-3 text-xs font-medium transition-all',
                        'hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md hover:shadow-primary/10',
                        'active:scale-95 active:translate-y-0',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        'disabled:pointer-events-none disabled:opacity-40',
                        isArmed
                          ? 'border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/30'
                          : isSuggested
                            ? 'border-primary/60 bg-primary/10 ring-2 ring-primary/60 hover:bg-accent hover:text-accent-foreground'
                            : 'border-border/70 bg-secondary/40 hover:bg-accent hover:text-accent-foreground',
                      )}
                      style={{ ['--cat-color']: c.color }}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'absolute inset-x-0 -bottom-6 h-12 rounded-full blur-2xl transition-opacity group-hover:opacity-60',
                          isSuggested && !isArmed ? 'opacity-40' : 'opacity-0',
                        )}
                        style={{ backgroundColor: c.color }}
                      />
                      <span className="relative text-2xl transition-transform duration-200 group-hover:scale-110" aria-hidden>
                        {c.icon}
                      </span>
                      <span className="relative truncate">
                        {isArmed ? 'Tap again' : c.name}
                      </span>
                    </button>
                  );
                })}
                {categories.length === 0 ? (
                  <p className="col-span-full text-sm text-muted-foreground">No categories yet.</p>
                ) : null}
              </div>
              {tripsLoading ? (
                <p className="text-xs text-muted-foreground">Checking your trips…</p>
              ) : !amountValid ? (
                <p className="text-xs text-muted-foreground">Enter an amount to enable categories.</p>
              ) : !rateValid ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Enter the {entryCurrency}/{currency} rate to enable categories.
                </p>
              ) : armedCategory ? (
                <p className="text-xs font-medium text-primary">
                  Tap {armedCategory.name} again to log it — or pick a different one.
                </p>
              ) : suggestedCategoryId ? (
                <p className="text-xs text-muted-foreground">Suggested — tap it twice to log, or pick another.</p>
              ) : (
                <p className="text-xs text-muted-foreground">Tap a category twice to log it.</p>
              )}
            </div>

            {/* Advanced: date + description (hidden by default to keep 3-tap promise) */}
            {/* Simple mode hides every advanced field, but must never hide a date
                the user is being asked to confirm on a pre-dated add — so that
                date shows, ALONE. Special and "Repeat this" stay hidden even then:
                handleSimpleLog never sends them, so showing them let a choice be
                ticked and silently thrown away (BUGS-FIXED.md, 2026-11-01). */}
            {simpleMode ? (
              initialDate && initialDate !== todayISO() ? dateField : null
            ) : (
              <div>
                <button
                  type="button"
                  onClick={() => setShowMore((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showMore && 'rotate-180')} />
                  {showMore
                    ? 'Hide details'
                    : type !== 'expense' || attached
                      ? 'Change the date'
                      : specialEnabled
                        ? 'Change the date, repeat it, or mark it special'
                        : 'Change the date or repeat it'}
                </button>

                {showMore ? (
                  <div className="mt-3 space-y-3">
                    {dateField}
                    {/* Ticked before the date moved into a trip. They come back with ✕. */}
                    {attached && type === 'expense' && (isSpecial || recurringInterval !== null) ? (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        On a trip, “Special” and “Repeat this” don’t apply, so they’re off for this one.
                      </p>
                    ) : null}

                    {/* Outside a trip's dates, the way to attach one by hand. */}
                    {type === 'expense' && !attached ? (
                      <TripPicker
                        tripId={null}
                        date={date}
                        showStops={false}
                        onTripChange={(id) => setTripChoice(id ? { tripId: id } : null)}
                      />
                    ) : null}
                    {specialEnabled && type === 'expense' && !attached ? (
                      <label className="flex items-center justify-between rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                        <span className="flex items-center gap-2 text-sm">
                          <Star className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
                          Special expense
                          <span className="text-xs text-muted-foreground">kept out of your monthly budget</span>
                        </span>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={isSpecial}
                          onChange={(e) => {
                            setIsSpecial(e.target.checked);
                            if (!e.target.checked) setSpecialGroupId(null);
                          }}
                        />
                      </label>
                    ) : null}

                    {/* Phase 10 B1 — only meaningful once it IS special. */}
                    {specialEnabled && type === 'expense' && isSpecial && !attached ? (
                      <SpecialGroupPicker
                        value={specialGroupId}
                        onChange={setSpecialGroupId}
                        className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2"
                      />
                    ) : null}

                    {/* Task 6.12b — recurring opt-in, expense-only. Hidden on a trip: a
                        repeating charge is home spending, and the server refuses the pair. */}
                    {type === 'expense' && !attached ? (
                      <div className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                        <label className="flex items-center justify-between">
                          <span className="flex items-center gap-2 text-sm">
                            <Repeat className="h-4 w-4 text-primary" aria-hidden />
                            Repeat this
                            <span className="text-xs text-muted-foreground">
                              logs itself from now on
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-primary"
                            checked={recurringInterval !== null}
                            onChange={(e) => setRecurringInterval(e.target.checked ? 'monthly' : null)}
                          />
                        </label>
                        {recurringInterval !== null ? (
                          <div className="mt-2 flex gap-1.5">
                            {['monthly', 'weekly'].map((iv) => (
                              <button
                                key={iv}
                                type="button"
                                onClick={() => setRecurringInterval(iv)}
                                aria-pressed={recurringInterval === iv}
                                className={cn(
                                  'rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors',
                                  recurringInterval === iv
                                    ? 'border-primary bg-primary/15 text-primary'
                                    : 'border-border/70 bg-secondary/40 text-muted-foreground hover:text-foreground',
                                )}
                              >
                                {iv}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}

            <div className="pt-1">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
