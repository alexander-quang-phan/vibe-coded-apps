import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Pencil } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MoneyInput, isValidMoney } from '@/components/ui/money-input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

function progressTone(percent) {
  if (percent >= 1)
    return {
      bar: 'from-rose-400 to-rose-500',
      copy: "You've gone over — want to adjust next month?",
    };
  if (percent >= 0.9)
    return {
      bar: 'from-amber-300 to-amber-500',
      copy: 'Getting close — tread lightly.',
    };
  if (percent >= 0.75)
    return {
      bar: 'from-amber-200 to-amber-400',
      copy: 'On track, but watch the last stretch.',
    };
  return {
    bar: 'from-emerald-400 to-primary',
    copy: 'You have room to breathe.',
  };
}

/**
 * Phase 10 (A5) — the overall monthly budget. Every expense category counts
 * toward this one number, which is what Alex was faking with a category
 * literally named "All Expenses". It's backed by user_stats.monthly_limit
 * (already there since migration 008, previously reachable only in Simple
 * mode), so there's no new table and no migration.
 */
function OverallBudgetCard({ overall, currency, onSave, onClear, saving }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const hasLimit = overall?.limit !== null && overall?.limit !== undefined;
  const percent = hasLimit ? Math.min(overall.percent, 1.1) : 0;
  const tone = progressTone(percent);
  const remaining = hasLimit ? overall.limit - overall.spent : 0;

  function startEditing() {
    setDraft(hasLimit ? String(overall.limit) : '');
    setEditing(true);
  }

  if (!hasLimit && !editing) {
    return (
      <Card className="relative overflow-hidden border-primary/30 bg-card/70 backdrop-blur">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 left-1/3 h-40 w-40 rounded-full bg-primary/15 blur-3xl"
        />
        <CardContent className="relative flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Overall monthly budget
            </h3>
            <p className="text-sm font-medium">Set one ceiling for everything</p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              Every category counts toward it — food, rent, the lot. Category budgets below
              become sub-limits inside this one.
            </p>
          </div>
          <Button onClick={startEditing} className="bg-gradient-to-br from-primary to-emerald-700">
            <Plus className="h-4 w-4" /> Set a total
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="relative overflow-hidden border-primary/30 bg-card/70 backdrop-blur">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-10 h-40 w-40 rounded-full bg-primary/20 blur-3xl"
      />
      <CardContent className="relative space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Overall monthly budget
            </h3>
            <p className="text-xs text-muted-foreground">Every category counts toward this</p>
          </div>
          {!editing ? (
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={startEditing} aria-label="Edit overall budget">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Remove overall budget"
                onClick={() => {
                  if (confirm('Remove your overall monthly budget?')) onClear();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}
        </div>

        {editing ? (
          <form
            className="flex max-w-sm gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (isValidMoney(draft) && !saving) {
                onSave(Number(draft));
                setEditing(false);
              }
            }}
          >
            <MoneyInput
              aria-label="Overall monthly budget"
              currency={currency}
              showSymbol
              containerClassName="flex-1"
              className="no-spin h-11 pl-8 text-lg font-semibold"
              value={draft}
              onValueChange={setDraft}
              autoFocus
            />
            <Button type="submit" className="h-11" disabled={!isValidMoney(draft) || saving}>
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="nums text-3xl font-extrabold tracking-tight">
                {remaining >= 0 ? (
                  <>
                    <span className="text-gradient">{formatMoney(remaining, currency)}</span>{' '}
                    <span className="text-base font-semibold text-muted-foreground">left</span>
                  </>
                ) : (
                  <>
                    {formatMoney(Math.abs(remaining), currency)}{' '}
                    <span className="text-base font-semibold text-rose-400">over</span>
                  </>
                )}
              </p>
              <span className="nums text-xs text-muted-foreground">
                {formatMoney(overall.spent, currency)} of {formatMoney(overall.limit, currency)}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted/70">
              <div
                className={cn(
                  'shimmer-bar h-full rounded-full bg-gradient-to-r transition-all duration-700',
                  tone.bar,
                )}
                style={{ width: `${Math.min(100, Math.round(percent * 100))}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">{tone.copy}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BudgetCard({ budget, currency, onEdit, onDelete }) {
  const percent = Math.min(budget.percent, 1.1);
  const tone = progressTone(percent);
  const remaining = budget.limit - budget.spent;
  const cat = budget.category;
  const color = cat?.color ?? '#10b981';

  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-12 -right-10 h-32 w-32 rounded-full opacity-30 blur-3xl"
        style={{ backgroundColor: color }}
      />
      <CardContent className="relative space-y-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="flex h-11 w-11 items-center justify-center rounded-xl text-xl ring-1 ring-border/60"
              style={{ backgroundColor: `${color}22` }}
            >
              {cat?.icon ?? '💰'}
            </span>
            <div>
              <h3 className="font-semibold leading-tight">{cat?.name ?? 'Category'}</h3>
              <p className="text-xs text-muted-foreground capitalize">{budget.period}</p>
            </div>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={() => onEdit(budget)} aria-label="Edit budget">
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(budget)}
              aria-label="Delete budget"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="nums text-2xl font-bold tracking-tight">
              {formatMoney(budget.spent, currency)}
            </span>
            <span className="nums text-sm text-muted-foreground">
              of {formatMoney(budget.limit, currency)}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted/70">
            <div
              className={`shimmer-bar h-full rounded-full bg-gradient-to-r ${tone.bar} transition-all duration-700`}
              style={{ width: `${Math.min(100, Math.round(percent * 100))}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{tone.copy}</span>
            <span
              className={cn(
                'nums font-medium',
                remaining >= 0 ? 'text-muted-foreground' : 'text-rose-400',
              )}
            >
              {remaining >= 0
                ? `${formatMoney(remaining, currency)} left`
                : `${formatMoney(Math.abs(remaining), currency)} over`}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BudgetDialog({ open, onOpenChange, editing, categoriesUsed, onSubmit, submitting, currency }) {
  const api = useApi();
  const { data: catsData } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
    enabled: open,
  });

  const availableCategories = useMemo(() => {
    const all = (catsData?.categories ?? []).filter((c) => c.type === 'expense');
    if (editing) return all;
    return all.filter((c) => !categoriesUsed.has(c.id));
  }, [catsData, categoriesUsed, editing]);

  const [categoryId, setCategoryId] = useState('');
  const [limit, setLimit] = useState('');
  const [period, setPeriod] = useState('monthly');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCategoryId(editing.category?.id ?? '');
      setLimit(String(editing.limit));
      setPeriod(editing.period);
    } else {
      setCategoryId('');
      setLimit('');
      setPeriod('monthly');
    }
  }, [editing, open]);

  const amount = Number(limit);
  const canSubmit = Boolean(editing || categoryId) && isValidMoney(limit);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit budget' : 'New budget'}</DialogTitle>
          <DialogDescription>
            Set a limit for a category. You'll see progress on your dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!editing ? (
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {availableCategories.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      All categories already have a budget.
                    </div>
                  ) : null}
                  {availableCategories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="mr-2">{c.icon}</span>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="limit">Amount</Label>
            <MoneyInput
              id="limit"
              currency={currency}
              value={limit}
              onValueChange={setLimit}
              className="no-spin"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Period</Label>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit({ categoryId, amountLimit: amount, period })}
            disabled={!canSubmit || submitting}
          >
            {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create budget'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Budgets() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['budgets'],
    queryFn: () => api.get('/api/budgets'),
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
  const currency = me?.preferences?.currency ?? 'GBP';

  const budgets = data?.budgets ?? [];
  const overall = data?.overall ?? null;
  const categoriesUsed = useMemo(
    () => new Set(budgets.map((b) => b.category?.id).filter(Boolean)),
    [budgets],
  );

  const createMutation = useMutation({
    mutationFn: (payload) => api.post('/api/budgets', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      queryClient.invalidateQueries({ queryKey: ['projections'] });
      toast.success('Budget created');
      setDialogOpen(false);
    },
    onError: (err) => toast.error(err?.message || 'Could not create budget'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => api.patch(`/api/budgets/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      queryClient.invalidateQueries({ queryKey: ['projections'] });
      toast.success('Budget updated');
      setDialogOpen(false);
      setEditing(null);
    },
    onError: (err) => toast.error(err?.message || 'Could not update budget'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.del(`/api/budgets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      queryClient.invalidateQueries({ queryKey: ['projections'] });
      toast.success('Budget removed');
    },
    onError: (err) => toast.error(err?.message || 'Could not delete'),
  });

  // Phase 10 (A5). The overall budget is user_stats.monthly_limit, so it saves
  // through PATCH /api/me — no new route. Null clears it.
  const overallMutation = useMutation({
    mutationFn: (monthlyLimit) => api.patch('/api/me', { monthlyLimit }),
    onSuccess: (_res, monthlyLimit) => {
      for (const key of ['budgets', 'dashboard', 'projections', 'me', 'wins']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      toast.success(monthlyLimit === null ? 'Overall budget removed' : 'Overall budget set', {
        description:
          monthlyLimit === null ? undefined : 'Every category now counts toward it.',
      });
    },
    onError: (err) => toast.error(err?.message || 'Could not save your overall budget'),
  });

  function handleSubmit({ categoryId, amountLimit, period }) {
    if (editing) {
      updateMutation.mutate({ id: editing.id, payload: { amountLimit, period } });
    } else {
      createMutation.mutate({ categoryId, amountLimit, period });
    }
  }

  return (
    <div className="space-y-5 pb-12 animate-fade-up">
      <header className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Set a ceiling, we'll keep count.</p>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Budgets</h1>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          className="bg-gradient-to-br from-primary to-emerald-700 shadow-md shadow-primary/30 transition-transform hover:scale-[1.02]"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New budget</span>
        </Button>
      </header>

      {!isLoading && !isError ? (
        <OverallBudgetCard
          overall={overall}
          currency={currency}
          saving={overallMutation.isPending}
          onSave={(limit) => overallMutation.mutate(limit)}
          onClear={() => overallMutation.mutate(null)}
        />
      ) : null}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : isError ? (
        <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm font-medium">Couldn't load your budgets.</p>
          <p className="text-xs text-muted-foreground">{error?.message}</p>
          <button onClick={() => refetch()} className="text-sm font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      ) : budgets.length === 0 ? (
        <Card className="relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-20 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
          />
          <CardContent className="relative flex flex-col items-center gap-3 p-10 text-center">
            <span className="text-5xl animate-float-slow" aria-hidden>
              🎯
            </span>
            <div className="space-y-1">
              <p className="font-semibold">No category budgets yet</p>
              <p className="text-sm text-muted-foreground">
                Pick a spending category and give it a ceiling of its own.
              </p>
            </div>
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
              className="bg-gradient-to-br from-primary to-emerald-700 shadow-md shadow-primary/30"
            >
              <Plus className="h-4 w-4" /> Create your first budget
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {budgets.map((b) => (
            <BudgetCard
              key={b.id}
              budget={b}
              currency={currency}
              onEdit={(x) => {
                setEditing(x);
                setDialogOpen(true);
              }}
              onDelete={(x) => {
                if (confirm(`Remove budget for ${x.category?.name ?? 'this category'}?`)) {
                  deleteMutation.mutate(x.id);
                }
              }}
            />
          ))}
        </div>
      )}

      <BudgetDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) setEditing(null);
        }}
        editing={editing}
        categoriesUsed={categoriesUsed}
        onSubmit={handleSubmit}
        submitting={createMutation.isPending || updateMutation.isPending}
        currency={currency}
      />
    </div>
  );
}
