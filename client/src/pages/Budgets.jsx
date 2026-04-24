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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

function progressTone(percent) {
  if (percent >= 1) return { color: 'bg-rose-400', copy: "You've gone over — want to adjust next month?" };
  if (percent >= 0.9) return { color: 'bg-amber-400', copy: 'Getting close — tread lightly.' };
  if (percent >= 0.75) return { color: 'bg-amber-300', copy: 'On track, but watch the last stretch.' };
  return { color: 'bg-primary', copy: 'You have room to breathe.' };
}

function BudgetCard({ budget, currency, onEdit, onDelete }) {
  const percent = Math.min(budget.percent, 1.1);
  const tone = progressTone(percent);
  const remaining = budget.limit - budget.spent;
  const cat = budget.category;

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-xl">
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
            <span className="text-2xl font-bold tracking-tight">
              {formatMoney(budget.spent, currency)}
            </span>
            <span className="text-sm text-muted-foreground">
              of {formatMoney(budget.limit, currency)}
            </span>
          </div>
          <Progress
            className="mt-2 h-2"
            value={Math.round(percent * 100)}
            indicatorClassName={tone.color}
          />
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{tone.copy}</span>
            <span
              className={cn(
                'font-medium',
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

function BudgetDialog({ open, onOpenChange, editing, categoriesUsed, onSubmit, submitting }) {
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
  const canSubmit = (editing || categoryId) && Number.isFinite(amount) && amount > 0;

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
            <Input
              id="limit"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
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
  const categoriesUsed = useMemo(
    () => new Set(budgets.map((b) => b.category?.id).filter(Boolean)),
    [budgets],
  );

  const createMutation = useMutation({
    mutationFn: (payload) => api.post('/api/budgets', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
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
      toast.success('Budget removed');
    },
    onError: (err) => toast.error(err?.message || 'Could not delete'),
  });

  function handleSubmit({ categoryId, amountLimit, period }) {
    if (editing) {
      updateMutation.mutate({ id: editing.id, payload: { amountLimit, period } });
    } else {
      createMutation.mutate({ categoryId, amountLimit, period });
    }
  }

  return (
    <div className="space-y-5 pb-12">
      <header className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Set a ceiling, we'll keep count.</p>
          <h1 className="text-3xl font-bold tracking-tight">Budgets</h1>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New budget</span>
        </Button>
      </header>

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
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="text-4xl" aria-hidden>
              🎯
            </span>
            <div className="space-y-1">
              <p className="font-medium">No budgets yet</p>
              <p className="text-sm text-muted-foreground">
                Pick a spending category and give it a ceiling.
              </p>
            </div>
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
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
      />
    </div>
  );
}
