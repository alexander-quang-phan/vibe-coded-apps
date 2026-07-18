import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Pencil, Search, Star, Trash2 } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { SegmentGroup, SegmentButton } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/useApi';
import { formatMoney, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(rows, filename) {
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function EditDialog({ tx, open, onOpenChange, categories, onSave, saving, specialEnabled = false }) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isSpecial, setIsSpecial] = useState(false);

  useEffect(() => {
    if (!tx || !open) return;
    setAmount(String(tx.amount));
    setDescription(tx.description ?? '');
    setDate(tx.date);
    setCategoryId(tx.category_id);
    setIsSpecial(!!tx.is_special);
  }, [tx, open]);

  if (!tx) return null;
  const amountNum = Number(amount);
  const sameTypeCats = categories.filter((c) => c.type === tx.type);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit transaction</DialogTitle>
          <DialogDescription>
            {tx.type === 'expense' ? 'Expense' : 'Income'} · adjust any field and save.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-amount">Amount</Label>
            <Input
              id="edit-amount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="no-spin"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sameTypeCats.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="mr-2">{c.icon}</span>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-date">Date</Label>
            <Input id="edit-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-desc">Note</Label>
            <Input
              id="edit-desc"
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {specialEnabled && tx.type === 'expense' ? (
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
                onChange={(e) => setIsSpecial(e.target.checked)}
              />
            </label>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSave({
                amount: amountNum,
                categoryId,
                date,
                description: description.trim() || null,
                ...(tx.type === 'expense' ? { isSpecial } : {}),
              })
            }
            disabled={saving || !(amountNum > 0) || !categoryId || !date}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Transactions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [monthFilter, setMonthFilter] = useState('all');
  const [specialFilter, setSpecialFilter] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => api.get('/api/transactions?limit=200'),
  });
  const { data: catsData } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
  const currency = me?.preferences?.currency ?? 'GBP';
  const specialEnabled = !!me?.preferences?.specialExpensesEnabled;

  const categories = catsData?.categories ?? [];
  const catsById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const months = useMemo(() => {
    const set = new Set();
    for (const t of data?.transactions ?? []) set.add(t.date.slice(0, 7));
    return [...set].sort().reverse();
  }, [data]);

  const filtered = useMemo(() => {
    const list = data?.transactions ?? [];
    const query = q.trim().toLowerCase();
    return list.filter((t) => {
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (categoryFilter !== 'all' && t.category_id !== categoryFilter) return false;
      if (monthFilter !== 'all' && !t.date.startsWith(monthFilter)) return false;
      if (specialEnabled && specialFilter && !t.is_special) return false;
      if (query) {
        const cat = catsById.get(t.category_id)?.name?.toLowerCase() ?? '';
        const desc = (t.description ?? '').toLowerCase();
        if (!cat.includes(query) && !desc.includes(query)) return false;
      }
      return true;
    });
  }, [data, typeFilter, categoryFilter, monthFilter, specialFilter, specialEnabled, q, catsById]);

  const totals = useMemo(() => {
    let income = 0;
    let expenses = 0;
    for (const t of filtered) {
      if (t.type === 'income') income += Number(t.amount);
      else expenses += Number(t.amount);
    }
    return { income, expenses };
  }, [filtered]);

  const deleteMutation = useMutation({
    mutationFn: (id) => api.del(`/api/transactions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      queryClient.invalidateQueries({ queryKey: ['projections'] });
      toast.success('Transaction removed');
    },
    onError: (err) => toast.error(err?.message || 'Could not delete'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => api.patch(`/api/transactions/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      queryClient.invalidateQueries({ queryKey: ['projections'] });
      toast.success('Updated');
      setEditing(null);
    },
    onError: (err) => toast.error(err?.message || 'Could not update'),
  });

  function handleExport() {
    const header = ['Date', 'Type', 'Category', 'Description', 'Amount'];
    const rows = [header];
    for (const t of filtered) {
      rows.push([
        t.date,
        t.type,
        catsById.get(t.category_id)?.name ?? '',
        t.description ?? '',
        t.amount,
      ]);
    }
    downloadCsv(rows, `trim-transactions-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <div className="space-y-5 pb-12 animate-fade-up">
      <header className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">The full log, searchable and exportable.</p>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Transactions</h1>
        </div>
        <Button
          variant="outline"
          onClick={handleExport}
          disabled={!filtered.length}
          className="border-border/60 bg-card/60 backdrop-blur"
        >
          <Download className="h-4 w-4" />
          <span className="hidden sm:inline">Export CSV</span>
        </Button>
      </header>

      <Card className="border-border/60 bg-card/70 backdrop-blur">
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr,auto,auto,auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search category or note"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={monthFilter} onValueChange={setMonthFilter}>
              <SelectTrigger className="sm:w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All months</SelectItem>
                {months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {new Date(`${m}-01T00:00:00`).toLocaleString(undefined, {
                      month: 'short',
                      year: 'numeric',
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="sm:w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="mr-2">{c.icon}</span>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentGroup>
                <SegmentButton active={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>
                  All
                </SegmentButton>
                <SegmentButton
                  active={typeFilter === 'expense'}
                  onClick={() => setTypeFilter('expense')}
                >
                  Out
                </SegmentButton>
                <SegmentButton
                  active={typeFilter === 'income'}
                  onClick={() => setTypeFilter('income')}
                >
                  In
                </SegmentButton>
              </SegmentGroup>
              {specialEnabled ? (
                <button
                  type="button"
                  onClick={() => setSpecialFilter((v) => !v)}
                  aria-pressed={specialFilter}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    specialFilter
                      ? 'border-amber-400/60 bg-amber-400/10 text-amber-400'
                      : 'border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Star className={cn('h-3.5 w-3.5', specialFilter && 'fill-amber-400')} aria-hidden />
                  Special
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-secondary/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
            </span>
            <span className="nums rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              +{formatMoney(totals.income, currency)}
            </span>
            <span className="nums rounded-full bg-rose-400/10 px-2.5 py-0.5 text-xs font-medium text-rose-400">
              −{formatMoney(totals.expenses, currency)}
            </span>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : isError ? (
        <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm font-medium">Couldn't load transactions.</p>
          <p className="text-xs text-muted-foreground">{error?.message}</p>
          <button onClick={() => refetch()} className="text-sm font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-border/60 bg-card/70 backdrop-blur">
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <span className="text-4xl animate-float-slow" aria-hidden>
              🧾
            </span>
            <p className="font-semibold">Nothing to show here</p>
            <p className="text-sm text-muted-foreground">
              Try loosening a filter, or tap the + button on Dashboard to log one.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border/60 bg-card/70 backdrop-blur">
          <CardContent className="divide-y divide-border/60 p-0">
            {filtered.map((t) => {
              const cat = catsById.get(t.category_id);
              const isIncome = t.type === 'income';
              const color = cat?.color ?? '#64748b';
              return (
                <div
                  key={t.id}
                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
                >
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-xl text-lg ring-1 ring-border/60"
                    style={{ backgroundColor: `${color}22` }}
                  >
                    {cat?.icon ?? '📦'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {t.description || cat?.name || 'Transaction'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {cat?.name ?? '—'} · {formatDate(t.date, { format: 'relative' })}
                    </p>
                  </div>
                  <div
                    className={cn(
                      'flex items-center gap-1.5 nums text-sm font-semibold',
                      isIncome ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {me?.preferences?.specialExpensesEnabled && t.is_special ? (
                      <Star className="h-3.5 w-3.5 text-amber-400" aria-label="Special expense" />
                    ) : null}
                    {isIncome ? '+' : '−'}
                    {formatMoney(Number(t.amount), currency)}
                  </div>
                  <div className="flex gap-0.5">
                    {me?.preferences?.specialExpensesEnabled && t.type === 'expense' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={t.is_special ? 'Unmark special' : 'Mark as special'}
                        onClick={() => updateMutation.mutate({ id: t.id, payload: { isSpecial: !t.is_special } })}
                      >
                        <Star
                          className={cn(
                            'h-3.5 w-3.5',
                            t.is_special ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground',
                          )}
                        />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setEditing(t)}
                      aria-label="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        if (confirm('Delete this transaction?')) deleteMutation.mutate(t.id);
                      }}
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <EditDialog
        tx={editing}
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        categories={categories}
        saving={updateMutation.isPending}
        specialEnabled={specialEnabled}
        onSave={(payload) => updateMutation.mutate({ id: editing.id, payload })}
      />
    </div>
  );
}
