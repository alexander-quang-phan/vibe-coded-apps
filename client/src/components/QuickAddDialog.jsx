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
import { SpecialGroupPicker } from '@/components/SpecialGroupPicker';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { SegmentGroup, SegmentButton } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/useApi';
import { cn } from '@/lib/utils';
import {
  celebrateLevelUp,
  celebrateStreakMilestone,
  celebrateShieldEarned,
} from '@/lib/confetti';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

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
  // card to backfill a month with nothing logged. Defaults to today, so every
  // existing caller is unaffected.
  initialDate = todayISO(),
}) {
  const api = useApi();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState('structured');
  const [type, setType] = useState('expense');
  const [amountStr, setAmountStr] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(initialDate);
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
  const amountRef = useRef(null);
  const freeformRef = useRef(null);

  useEffect(() => {
    if (open) {
      setMode('structured');
      setType('expense');
      setAmountStr('');
      setDescription('');
      setDate(initialDate);
      // Auto-open the advanced section when the date is not today, so a pre-dated
      // add is never invisible. Same rule as the AI parser below, which already
      // does this when it moves the date off today.
      setShowMore(initialDate !== todayISO());
      setFreeformText('');
      setParseError(null);
      setSuggestedCategoryId(null);
      setArmedCategoryId(null);
      setIsSpecial(false);
      setRecurringInterval(null);
      setSpecialGroupId(null);
      setTimeout(() => amountRef.current?.focus(), 80);
    }
  }, [open, initialDate]);

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

  const mutation = useMutation({
    mutationFn: (payload) => api.post('/api/transactions', payload),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      queryClient.invalidateQueries({ queryKey: ['projections'] });
      // A recurring opt-in creates a row that surfaces on /subscriptions.
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      // Any add changes a month's totals, so the average card and the history
      // list are both stale. Was missing entirely: a backdated add from the
      // Dashboard used to leave Analytics wrong until a hard refresh.
      queryClient.invalidateQueries({ queryKey: ['analytics'] });

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
      } else if (type === 'expense' && isSpecial) {
        toast.success('Logged as special ⭐', { description: 'Outside your monthly budget' });
      } else {
        toast.success('Logged', { description: `+${d?.awardedXp ?? 0} XP` });
      }

      if (d?.shieldUsed) {
        toast('Streak shield used 🛡️', {
          description: 'You missed yesterday but we saved your streak.',
        });
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
    if (!amountValid || mutation.isPending) return;
    // First tap on a chip only arms it; tapping a different chip moves the
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
      ...(type === 'expense' ? { isSpecial } : {}),
      ...(type === 'expense' && isSpecial && specialGroupId ? { specialGroupId } : {}),
      ...(type === 'expense' && recurringInterval
        ? { recurring: { interval: recurringInterval } }
        : {}),
    });
  }

  // Simple mode files everything against the seeded "Other" expense category
  // — the deliberate 2-tap exception to the 3-tap rule (FEATURES.md).
  function handleSimpleLog() {
    if (!amountValid || mutation.isPending) return;
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
              <Label htmlFor="qa-amount">Amount</Label>
              <MoneyInput
                id="qa-amount"
                ref={amountRef}
                currency={currency}
                showSymbol
                symbolClassName="left-4 text-2xl"
                className="no-spin h-16 pl-10 text-3xl font-bold tracking-tight"
                value={amountStr}
                onValueChange={(v) => {
                  setAmountStr(v);
                  setArmedCategoryId(null);
                }}
              />
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
                disabled={!amountValid || mutation.isPending}
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
                      disabled={!amountValid || mutation.isPending}
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
              {!amountValid ? (
                <p className="text-xs text-muted-foreground">Enter an amount to enable categories.</p>
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
            {/* Simple mode hides this for ordinary adds, but must never hide a
                date the user is being asked to confirm on a pre-dated add. */}
            <div className={simpleMode && initialDate === todayISO() ? 'hidden' : undefined}>
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showMore && 'rotate-180')} />
                {showMore
                  ? 'Hide details'
                  : type !== 'expense'
                    ? 'Change the date'
                    : specialEnabled
                      ? 'Change the date, repeat it, or mark it special'
                      : 'Change the date or repeat it'}
              </button>

              {showMore ? (
                <div className="mt-3 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="qa-date">Date</Label>
                    <Input
                      id="qa-date"
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </div>
                  {specialEnabled && type === 'expense' ? (
                    <label className="flex items-center justify-between rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                      <span className="flex items-center gap-2 text-sm">
                        <Star className="h-4 w-4 text-amber-400" aria-hidden />
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
                  {specialEnabled && type === 'expense' && isSpecial ? (
                    <SpecialGroupPicker
                      value={specialGroupId}
                      onChange={setSpecialGroupId}
                      className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2"
                    />
                  ) : null}

                  {/* Task 6.12b — recurring opt-in, expense-only. */}
                  {type === 'expense' ? (
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
