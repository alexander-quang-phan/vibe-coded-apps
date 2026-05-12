import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, Sparkles, ArrowLeft, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { SegmentGroup, SegmentButton } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';
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

export function QuickAddDialog({ open, onOpenChange, currency = 'GBP' }) {
  const api = useApi();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState('structured');
  const [type, setType] = useState('expense');
  const [amountStr, setAmountStr] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());
  const [showMore, setShowMore] = useState(false);
  const [freeformText, setFreeformText] = useState('');
  const [parseError, setParseError] = useState(null);
  const [suggestedCategoryId, setSuggestedCategoryId] = useState(null);
  const amountRef = useRef(null);
  const freeformRef = useRef(null);

  useEffect(() => {
    if (open) {
      setMode('structured');
      setType('expense');
      setAmountStr('');
      setDescription('');
      setDate(todayISO());
      setShowMore(false);
      setFreeformText('');
      setParseError(null);
      setSuggestedCategoryId(null);
      setTimeout(() => amountRef.current?.focus(), 80);
    }
  }, [open]);

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

  const categories = useMemo(() => {
    const all = categoriesData?.categories ?? [];
    return all.filter((c) => c.type === type);
  }, [categoriesData, type]);

  const amount = Number(amountStr);
  const amountValid = amountStr !== '' && Number.isFinite(amount) && amount > 0;

  const mutation = useMutation({
    mutationFn: (payload) => api.post('/api/transactions', payload),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      queryClient.invalidateQueries({ queryKey: ['projections'] });

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
      // Reveal advanced section if AI populated date or note so user sees what was set.
      setShowMore((p.occurredAt && p.occurredAt !== todayISO()) || Boolean(p.description));
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
    mutation.mutate({
      categoryId: category.id,
      amount,
      type,
      description: description.trim() || null,
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
      <DialogContent className="max-h-[94vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log a transaction</DialogTitle>
          <DialogDescription>
            {mode === 'freeform'
              ? 'Describe it in your own words — we’ll turn it into a draft.'
              : "Amount, then tap a category. That's it."}
          </DialogDescription>
        </DialogHeader>

        <div className="-mt-1 flex justify-end">
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
            {/* Step 1: type */}
            <SegmentGroup className="self-start">
              <SegmentButton active={type === 'expense'} onClick={() => setType('expense')}>
                Expense
              </SegmentButton>
              <SegmentButton active={type === 'income'} onClick={() => setType('income')}>
                Income
              </SegmentButton>
            </SegmentGroup>

            {/* Step 2: amount */}
            <div className="space-y-2">
              <Label htmlFor="qa-amount">Amount</Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-2xl font-semibold text-muted-foreground">
                  {formatMoney(0, currency).replace(/\d|[.,]/g, '').trim() || '$'}
                </span>
                <Input
                  id="qa-amount"
                  ref={amountRef}
                  className="no-spin h-16 pl-10 text-3xl font-bold tracking-tight"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>

            {/* Step 3: category chips — auto-submits on tap */}
            <div className="space-y-2">
              <Label>Category</Label>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {categories.map((c) => {
                  const isSuggested = c.id === suggestedCategoryId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!amountValid || mutation.isPending}
                      onClick={() => handleCategoryTap(c)}
                      className={cn(
                        'group relative flex flex-col items-center gap-1.5 overflow-hidden rounded-xl border p-3 text-xs font-medium transition-all',
                        'hover:-translate-y-0.5 hover:border-primary/50 hover:bg-accent hover:text-accent-foreground hover:shadow-md hover:shadow-primary/10',
                        'active:scale-95 active:translate-y-0',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        'disabled:pointer-events-none disabled:opacity-40',
                        isSuggested
                          ? 'border-primary/60 bg-primary/10 ring-2 ring-primary/60'
                          : 'border-border/70 bg-secondary/40',
                      )}
                      style={{ ['--cat-color']: c.color }}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'absolute inset-x-0 -bottom-6 h-12 rounded-full blur-2xl transition-opacity group-hover:opacity-60',
                          isSuggested ? 'opacity-40' : 'opacity-0',
                        )}
                        style={{ backgroundColor: c.color }}
                      />
                      <span className="relative text-2xl transition-transform duration-200 group-hover:scale-110" aria-hidden>
                        {c.icon}
                      </span>
                      <span className="relative truncate">{c.name}</span>
                    </button>
                  );
                })}
                {categories.length === 0 ? (
                  <p className="col-span-full text-sm text-muted-foreground">No categories yet.</p>
                ) : null}
              </div>
              {!amountValid ? (
                <p className="text-xs text-muted-foreground">Enter an amount to enable categories.</p>
              ) : suggestedCategoryId ? (
                <p className="text-xs text-muted-foreground">Suggested — tap to confirm, or pick another.</p>
              ) : null}
            </div>

            {/* Advanced: date + description (hidden by default to keep 3-tap promise) */}
            <div>
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showMore && 'rotate-180')} />
                {showMore ? 'Hide details' : 'Add a note or change the date'}
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
                  <div className="space-y-1.5">
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
