import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

export function QuickAddDialog({ open, onOpenChange, currency = 'GBP' }) {
  const api = useApi();
  const queryClient = useQueryClient();

  const [type, setType] = useState('expense');
  const [amountStr, setAmountStr] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());
  const [showMore, setShowMore] = useState(false);
  const amountRef = useRef(null);

  useEffect(() => {
    if (open) {
      setType('expense');
      setAmountStr('');
      setDescription('');
      setDate(todayISO());
      setShowMore(false);
      // Focus the amount input on open for the fastest possible flow.
      setTimeout(() => amountRef.current?.focus(), 80);
    }
  }, [open]);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log a transaction</DialogTitle>
          <DialogDescription>Amount, then tap a category. That's it.</DialogDescription>
        </DialogHeader>

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
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={!amountValid || mutation.isPending}
                onClick={() => handleCategoryTap(c)}
                className={cn(
                  'group flex flex-col items-center gap-1 rounded-xl border border-border bg-secondary/40 p-3 text-xs font-medium transition-all',
                  'hover:border-primary/40 hover:bg-accent hover:text-accent-foreground active:scale-95',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:pointer-events-none disabled:opacity-40',
                )}
              >
                <span className="text-2xl" aria-hidden>
                  {c.icon}
                </span>
                <span className="truncate">{c.name}</span>
              </button>
            ))}
            {categories.length === 0 ? (
              <p className="col-span-full text-sm text-muted-foreground">No categories yet.</p>
            ) : null}
          </div>
          {!amountValid ? (
            <p className="text-xs text-muted-foreground">Enter an amount to enable categories.</p>
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
      </DialogContent>
    </Dialog>
  );
}
