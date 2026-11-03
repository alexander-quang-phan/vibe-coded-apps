import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyInput, isValidMoney } from '@/components/ui/money-input';
import { CategoryDialog } from '@/components/CategoryManager';
import { useApi } from '@/hooks/useApi';
import { currencyOptions } from '@/lib/fx';
import { invalidateMoney } from '@/lib/invalidate';
import { tripDates } from '@/lib/trips';

let nextKey = 0;
const rowKey = () => `row-${(nextKey += 1)}`;

function blankStop() {
  return { key: rowKey(), name: '', startDate: '', endDate: '', budget: '', currency: '' };
}

/**
 * The trip editor: one save for everything, so postponing a trip with its stops just
 * works. Creating, editing and "Start from a special group" are the same form.
 *
 * Seeded when it OPENS, never in an effect on query data: a refetch must not wipe what
 * Alex has typed (BUGS-FIXED shape 8). `trip` and `fromGroup` are read at that moment.
 */
export function TripEditor({
  open,
  onOpenChange,
  trip = null,
  fromGroup = null,
  currency,
  specialEnabled,
  simpleMode,
  onSaved,
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [totalBudget, setTotalBudget] = useState('');
  const [keepOut, setKeepOut] = useState(true);
  const [stops, setStops] = useState([]);
  const [budgets, setBudgets] = useState([]);
  const [confirmingFlip, setConfirmingFlip] = useState(false);
  const [newCategoryOpen, setNewCategoryOpen] = useState(false);

  const seededFor = useRef(false);
  useEffect(() => {
    if (!open) {
      seededFor.current = false;
      return;
    }
    if (seededFor.current) return;
    seededFor.current = true;
    setConfirmingFlip(false);
    setName(trip?.name ?? fromGroup?.name ?? '');
    // Dates are left empty on a conversion: pre-filling from the first and last expense
    // takes in flights booked months earlier, so the "trip" would look on now.
    setStartDate(trip?.startDate ?? '');
    setEndDate(trip?.endDate ?? '');
    setTotalBudget(trip?.totalBudget != null ? String(trip.totalBudget) : '');
    setKeepOut(trip?.keepOutOfMonthly ?? true);
    setStops((trip?.stops ?? []).map((s) => ({
      key: rowKey(),
      id: s.id,
      name: s.name,
      startDate: s.startDate,
      endDate: s.endDate,
      budget: s.budget != null ? String(s.budget) : '',
      currency: s.currency ?? '',
    })));
    setBudgets((trip?.categoryBudgets ?? []).map((b) => ({
      key: rowKey(),
      categoryId: b.categoryId,
      amount: String(b.amount),
    })));
  }, [open, trip, fromGroup]);

  const { data: catsData } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
    enabled: open && !simpleMode,
  });
  const expenseCategories = useMemo(
    () => (catsData?.categories ?? []).filter((c) => c.type === 'expense'),
    [catsData],
  );

  const problem = useMemo(() => {
    if (!name.trim()) return 'Give the trip a name.';
    if (!startDate || !endDate) return 'Enter its start and end dates.';
    if (endDate < startDate) return 'A trip can’t end before it starts.';
    if (totalBudget !== '' && !isValidMoney(totalBudget)) return 'Check the overall budget.';
    for (const s of stops) {
      if (!s.name.trim()) return 'Give every stop a city.';
      if (!s.startDate || !s.endDate) return `Enter dates for ${s.name.trim()}.`;
      if (s.endDate < s.startDate) return `${s.name.trim()} can’t end before it starts.`;
      if (s.startDate < startDate || s.endDate > endDate) return `${s.name.trim()} has to sit inside the trip’s dates.`;
      if (s.budget !== '' && !isValidMoney(s.budget)) return `Check the budget for ${s.name.trim()}.`;
    }
    for (const b of budgets) {
      if (!b.categoryId) return 'Pick a category for every budget line.';
      if (!isValidMoney(b.amount)) return 'Check the category budgets.';
    }
    return null;
  }, [name, startDate, endDate, totalBudget, stops, budgets]);

  function body() {
    return {
      name: name.trim(),
      startDate,
      endDate,
      totalBudget: totalBudget === '' ? null : Number(totalBudget),
      keepOutOfMonthly: keepOut,
      stops: stops.map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        name: s.name.trim(),
        startDate: s.startDate,
        endDate: s.endDate,
        budget: s.budget === '' ? null : Number(s.budget),
        currency: s.currency || null,
      })),
      // Simple mode files everything under "Other", so it has no budget lines to send,
      // and an empty list on a PATCH would delete the ones already there.
      ...(simpleMode
        ? {}
        : { categoryBudgets: budgets.map((b) => ({ categoryId: b.categoryId, amount: Number(b.amount) })) }),
    };
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (trip) return api.patch(`/api/trips/${trip.id}`, body());
      if (fromGroup) return api.post('/api/trips/from-group', { groupId: fromGroup.id, trip: body() });
      return api.post('/api/trips', body());
    },
    onSuccess: (res) => {
      invalidateMoney(queryClient);
      if (res?.specialEnabledNow) {
        toast('Special expenses is on now', { description: 'Trip spending stays out of your monthly budgets.' });
      }
      if (fromGroup) {
        toast.success(`${res?.moved ?? 0} expenses moved to ${res?.trip?.name}`, {
          description: res?.groupArchived === false ? 'Its group is empty now and can be archived by hand.' : undefined,
        });
      } else {
        toast.success(trip ? 'Trip saved' : 'Trip created ✈️');
      }
      onOpenChange(false);
      onSaved?.(res?.trip);
    },
    onError: (err) => {
      invalidateMoney(queryClient);
      // A 4xx was refused before anything was written, so the form is still right to fix.
      // Anything else may have saved part-way. Reopening seeds from the server, where any
      // new stops now have ids, so saving again can't insert them twice.
      if (trip && !(err?.status >= 400 && err?.status < 500)) {
        toast.error('Some changes may have saved', { description: 'Open the trip to check, then save again.' });
        onOpenChange(false);
        return;
      }
      toast.error(err?.message || 'Couldn’t save the trip');
    },
  });

  const newCategoryMutation = useMutation({
    mutationFn: (payload) => api.post('/api/categories', payload),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      setBudgets((list) => [...list, { key: rowKey(), categoryId: res.category.id, amount: '' }]);
      setNewCategoryOpen(false);
    },
    onError: (err) => toast.error(err?.message || 'Couldn’t add that category'),
  });

  const flips = !!trip && keepOut !== trip.keepOutOfMonthly && trip.count > 0;

  function save() {
    if (flips && !confirmingFlip) {
      setConfirmingFlip(true);
      return;
    }
    mutation.mutate();
  }

  const editStop = (key, patch) => setStops((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const editBudget = (key, patch) => setBudgets((list) => list.map((b) => (b.key === key ? { ...b, ...patch } : b)));

  const groupDates = fromGroup?.dates ?? [];
  const outsideDates = startDate && endDate
    ? groupDates.filter((d) => d < startDate || d > endDate).length
    : 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{trip ? 'Edit trip' : fromGroup ? `Start from ${fromGroup.name}` : 'New trip'}</DialogTitle>
            <DialogDescription>
              Set it up once: dates, cities and budgets save together.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="trip-name">Name</Label>
              <Input
                id="trip-name"
                value={name}
                maxLength={60}
                placeholder="e.g. Italy"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="trip-start">Starts</Label>
                <Input id="trip-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trip-end">Ends</Label>
                <Input id="trip-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>

            {fromGroup ? (
              <p className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                {groupDates.length === 0
                  ? 'This group has no expenses yet.'
                  : `Its ${groupDates.length} ${groupDates.length === 1 ? 'expense runs' : 'expenses run'} from ${tripDates(groupDates[0], groupDates.at(-1))}.`}
                {outsideDates > 0
                  ? ` ${outsideDates} ${outsideDates === 1 ? 'falls' : 'fall'} outside the dates you chose. They still join the trip.`
                  : ''}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="trip-budget">Overall budget (optional)</Label>
              <MoneyInput
                id="trip-budget"
                currency={currency}
                showSymbol
                value={totalBudget}
                onValueChange={setTotalBudget}
                className="no-spin"
              />
            </div>

            <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Keep this trip out of my monthly budget</span>
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-primary"
                  checked={keepOut}
                  onChange={(e) => {
                    setKeepOut(e.target.checked);
                    setConfirmingFlip(false);
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {keepOut
                  ? 'Trip spending won’t touch your monthly budgets or pace. It’s tracked here instead.'
                  : 'Trip spending counts here and in your monthly budgets.'}
              </p>
              {keepOut && !specialEnabled ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  This also turns on Special expenses for your account. Anything you starred before will stay out of your budgets too.
                </p>
              ) : null}
              {fromGroup && !keepOut && groupDates.length > 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {groupDates.length === 1
                    ? 'This expense will count in its month’s budget again.'
                    : `These ${groupDates.length} expenses will count in their months’ budgets again.`}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label>Stops (optional)</Label>
              {stops.map((s) => (
                <div key={s.key} className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="City"
                      placeholder="City"
                      value={s.name}
                      maxLength={60}
                      onChange={(e) => editStop(s.key, { name: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      aria-label={`Remove ${s.name || 'stop'}`}
                      onClick={() => setStops((list) => list.filter((x) => x.key !== s.key))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="date"
                      aria-label={`${s.name || 'Stop'} from`}
                      value={s.startDate}
                      onChange={(e) => editStop(s.key, { startDate: e.target.value })}
                    />
                    <Input
                      type="date"
                      aria-label={`${s.name || 'Stop'} to`}
                      value={s.endDate}
                      onChange={(e) => editStop(s.key, { endDate: e.target.value })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <MoneyInput
                      aria-label={`${s.name || 'Stop'} budget`}
                      placeholder="Budget"
                      currency={currency}
                      value={s.budget}
                      onValueChange={(v) => editStop(s.key, { budget: v })}
                      className="no-spin"
                    />
                    <select
                      aria-label={`${s.name || 'Stop'} currency`}
                      value={s.currency}
                      onChange={(e) => editStop(s.key, { currency: e.target.value })}
                      className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">Home currency</option>
                      {currencyOptions(currency).filter((c) => c !== currency).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setStops((list) => [...list, blankStop()])}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Add a stop
              </Button>
              {stops.length > 0 && currency !== 'VND' ? (
                <p className="text-xs text-muted-foreground">
                  Quick Add switches to a stop’s currency for you. VND isn’t offered yet: Trim can’t get a rate for it.
                </p>
              ) : null}
            </div>

            {simpleMode ? null : (
              <div className="space-y-2">
                <Label>Category budgets (optional)</Label>
                {budgets.map((b) => (
                  <div key={b.key} className="flex items-center gap-2">
                    <select
                      aria-label="Category"
                      value={b.categoryId ?? ''}
                      onChange={(e) => editBudget(b.key, { categoryId: e.target.value })}
                      className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">Category…</option>
                      {expenseCategories
                        .filter((c) => c.id === b.categoryId || !budgets.some((x) => x.categoryId === c.id))
                        .map((c) => (
                          <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                        ))}
                    </select>
                    <MoneyInput
                      aria-label="Category budget"
                      currency={currency}
                      value={b.amount}
                      onValueChange={(v) => editBudget(b.key, { amount: v })}
                      className="no-spin w-28"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      aria-label="Remove this budget"
                      onClick={() => setBudgets((list) => list.filter((x) => x.key !== b.key))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setBudgets((list) => [...list, { key: rowKey(), categoryId: '', amount: '' }])}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add a category budget
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setNewCategoryOpen(true)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    New category
                  </Button>
                </div>
              </div>
            )}
          </div>

          {problem ? <p className="text-xs text-muted-foreground">{problem}</p> : null}
          {confirmingFlip ? (
            <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Update {trip.count} {trip.count === 1 ? 'expense' : 'expenses'}? This also resets any you starred or un-starred by hand.
            </p>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!!problem || mutation.isPending}>
              {mutation.isPending
                ? 'Saving…'
                : confirmingFlip
                  ? `Update ${trip.count} ${trip.count === 1 ? 'expense' : 'expenses'}`
                  : trip ? 'Save' : 'Create trip'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CategoryDialog
        open={newCategoryOpen}
        onOpenChange={setNewCategoryOpen}
        editing={null}
        lockType="expense"
        submitting={newCategoryMutation.isPending}
        onSubmit={(payload) => newCategoryMutation.mutate(payload)}
      />
    </>
  );
}
