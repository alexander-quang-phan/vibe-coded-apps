import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Archive, ChevronDown, Pencil, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { QuickAddButton } from '@/components/QuickAddButton';
import { TransactionEditDialog } from '@/components/TransactionEditDialog';
import { TripEditor, noticeSpecialTurnedOn } from '@/components/TripEditor';
import { useApi } from '@/hooks/useApi';
import { celebrateGoalCompleted } from '@/lib/confetti';
import { formatDate, formatMoney } from '@/lib/format';
import { invalidateMoney } from '@/lib/invalidate';
import { progressTone } from '@/lib/progressTone';
import { cityOf, tripDates } from '@/lib/trips';
import { cn } from '@/lib/utils';

const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

function Bar({ label, spent, limit, currency }) {
  const percent = limit ? spent / limit : 0;
  const tone = progressTone(Math.min(percent, 1.1));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="nums shrink-0 text-muted-foreground">
          <span className="font-medium text-foreground">{formatMoney(spent, currency)}</span>
          {limit ? ` of ${formatMoney(limit, currency)}` : ''}
        </span>
      </div>
      {limit ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn('h-full rounded-full bg-gradient-to-r', tone.bar)}
            style={{ width: `${Math.min(percent, 1) * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Hero({ trip, currency }) {
  const money = (n) => formatMoney(n, currency);
  const when = trip.status === 'active'
    ? `Day ${trip.dayOfTrip} of ${trip.length}`
    : trip.status === 'upcoming'
      ? `Starts in ${days(trip.daysUntilStart)}`
      : `Ended ${new Date(`${trip.endDate}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  const budgeted = trip.totalBudget !== null;
  const over = trip.overBy > 0;

  let big;
  let line;
  if (!budgeted) {
    big = `${money(trip.spent)} spent`;
    line = null;
  } else if (trip.status === 'past') {
    big = over ? `Came in ${money(trip.overBy)} over` : `Came in ${money(trip.remaining)} under 🎉`;
    line = over ? 'Worth a bigger budget next time?' : `${money(trip.spent)} of ${money(trip.totalBudget)}`;
  } else if (over) {
    big = `${money(trip.overBy)} over`;
    line = trip.status === 'active' ? `Nothing left for the last ${days(trip.daysLeft)}` : `${money(trip.spent)} of ${money(trip.totalBudget)}`;
  } else {
    big = `${money(trip.remaining)} left`;
    line = trip.status === 'active'
      ? `${money(trip.perDayLeft)}/day for the ${days(trip.daysLeft)} left`
      : `of ${money(trip.totalBudget)}`;
  }

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="space-y-1 p-5">
        <p className="text-sm text-muted-foreground">{when}</p>
        <p className={cn('nums text-3xl font-extrabold tracking-tight sm:text-4xl', over && 'text-amber-600 dark:text-amber-400')}>
          {big}
        </p>
        {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
      </CardContent>
    </Card>
  );
}

function AddExpenses({ tripId, tripName, currency, categoriesById }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [ticked, setTicked] = useState(() => new Set());

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);

  const { data, isLoading } = useQuery({
    queryKey: ['trips', tripId, 'untagged', q],
    queryFn: () => api.get(`/api/trips/${tripId}/untagged?q=${encodeURIComponent(q)}`),
    enabled: open,
  });
  const during = data?.during ?? [];
  const before = data?.before ?? [];

  // Only what's on screen: a tick that has dropped off the list must never be submitted
  // behind Alex's back (BUGS-FIXED 2026-10-14).
  const shownIds = new Set([...during, ...before].map((t) => t.id));
  const chosen = [...ticked].filter((id) => shownIds.has(id));

  const add = useMutation({
    mutationFn: () => api.post(`/api/trips/${tripId}/transactions`, { transactionIds: chosen }),
    onSuccess: (res) => {
      invalidateMoney(queryClient);
      setTicked(new Set());
      toast.success(`Added ${res.added} to ${tripName} ✈️`);
    },
    onError: (err) => toast.error(err?.message || 'Couldn’t add them'),
  });

  function toggle(id) {
    setTicked((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const list = (title, rows) => (rows.length === 0 ? null : (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {rows.map((t) => (
        <label key={t.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/50">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-primary"
            checked={ticked.has(t.id)}
            onChange={() => toggle(t.id)}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">
              {t.description || categoriesById.get(t.category_id)?.name || 'Expense'}
            </span>
            <span className="block text-xs text-muted-foreground">{formatDate(t.date)}</span>
          </span>
          <span className="nums shrink-0 text-sm font-medium">{formatMoney(t.amount, currency)}</span>
        </label>
      ))}
    </div>
  ));

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="space-y-3 p-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 text-left text-sm font-semibold"
        >
          Add expenses
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        {open ? (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search your expenses"
                placeholder="Search your expenses"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="pl-9"
              />
            </div>
            {isLoading ? <Skeleton className="h-16" /> : null}
            {!isLoading && during.length === 0 && before.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing to add here.</p>
            ) : null}
            {list('During the trip', during)}
            {list('Before the trip', before)}
            {chosen.length > 100 ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">Add up to 100 at a time.</p>
            ) : null}
            <Button
              onClick={() => add.mutate()}
              disabled={chosen.length === 0 || chosen.length > 100 || add.isPending}
              className="w-full"
            >
              {add.isPending ? 'Adding…' : chosen.length === 0 ? 'Tick some to add them' : `Add ${chosen.length} to ${tripName}`}
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function celebrateOnce(tripId) {
  const key = `trim:trip-celebrated:${tripId}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, '1');
    return true;
  } catch {
    return false; // storage unavailable: no way to make it once-only, so skip it
  }
}

export default function TripDetail() {
  const { id } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['trips', id],
    queryFn: () => api.get(`/api/trips/${id}`),
    retry: (count, err) => err?.status !== 404 && count < 1,
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
  const { data: catsData } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
  });
  const currency = me?.preferences?.currency ?? 'GBP';
  const specialEnabled = !!me?.preferences?.specialExpensesEnabled;
  const simpleMode = !!me?.preferences?.simpleMode;
  const categoriesById = useMemo(
    () => new Map((catsData?.categories ?? []).map((c) => [c.id, c])),
    [catsData],
  );

  // A snapshot of the row: the dialog resets when this changes, so it must not be a row
  // derived from query data, or every refetch would wipe the form (BUGS-FIXED shape 8).
  const [editing, setEditing] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const trip = data?.trip ?? null;
  const summary = data?.summary ?? null;
  const transactions = useMemo(
    () => [...(data?.transactions ?? [])].sort((a, b) => b.date.localeCompare(a.date)),
    [data],
  );
  const stopsById = useMemo(() => new Map((trip?.stops ?? []).map((s) => [s.id, s])), [trip]);

  const cameInUnder = trip?.status === 'past' && trip?.totalBudget !== null && trip?.overBy === 0;
  useEffect(() => {
    if (cameInUnder && celebrateOnce(id)) {
      celebrateGoalCompleted();
      toast.success('You came in under budget 🎉', { description: 'Nicely done. That money’s still yours.' });
    }
  }, [cameInUnder, id]);

  const archive = useMutation({
    mutationFn: (archived) => api.patch(`/api/trips/${id}`, { archived }),
    onSuccess: (res, archived) => {
      invalidateMoney(queryClient);
      noticeSpecialTurnedOn(res);
      toast.success(archived ? 'Trip archived' : 'Trip restored', {
        description: archived ? 'Its expenses and figures stay. Quick Add won’t tag it any more.' : undefined,
      });
    },
    onError: (err) => toast.error(err?.message || 'Couldn’t update the trip'),
  });

  const remove = useMutation({
    mutationFn: (mode) => api.del(`/api/trips/${id}?expenses=${mode}`),
    onSuccess: () => {
      invalidateMoney(queryClient);
      toast.success('Trip deleted', { description: 'Its expenses are all still in Transactions.' });
      navigate('/trips', { replace: true });
    },
    onError: (err) => toast.error(err?.message || 'Couldn’t delete the trip'),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-32" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (isError && !data) {
    return (
      <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm font-medium">{error?.status === 404 ? 'We couldn’t find that trip.' : 'Couldn’t load this trip.'}</p>
        {error?.status === 404 ? (
          <Link to="/trips" className="text-sm font-medium text-primary hover:underline">Back to Trips</Link>
        ) : (
          <button onClick={() => refetch()} className="text-sm font-medium text-primary hover:underline">Try again</button>
        )}
      </div>
    );
  }

  const count = transactions.length;
  const archived = !!trip.archivedAt;
  const budgetedCategories = (summary?.byCategory ?? []).filter((b) => b.limit !== null);

  return (
    // pb-24, not pb-12: the floating add button would otherwise cover the last row.
    <div className="space-y-5 pb-24 animate-fade-up">
      <header className="space-y-3">
        <Link to="/trips" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Trips
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-muted-foreground">
              {tripDates(trip.startDate, trip.endDate)}
              {archived ? ' · Archived' : ''}
            </p>
            <h1 className="truncate text-3xl font-extrabold tracking-tight sm:text-4xl">{trip.name}</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditorOpen(true)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit trip
            </Button>
            <Button variant="outline" size="sm" onClick={() => archive.mutate(!archived)} disabled={archive.isPending}>
              <Archive className="h-3.5 w-3.5" aria-hidden />
              {archived ? 'Unarchive' : 'Archive'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
          </div>
        </div>
      </header>

      <Hero trip={trip} currency={currency} />

      {simpleMode || !summary || (budgetedCategories.length === 0 && summary.otherCategoriesSpent === 0) ? null : (
        <Card className="border-border/60 bg-card/70 backdrop-blur">
          <CardContent className="space-y-3 p-5">
            <h2 className="text-sm font-semibold">By category</h2>
            {budgetedCategories.map((b) => {
              const cat = categoriesById.get(b.categoryId);
              return (
                <Bar
                  key={b.categoryId}
                  label={cat ? `${cat.icon} ${cat.name}` : 'Category'}
                  spent={b.spent}
                  limit={b.limit}
                  currency={currency}
                />
              );
            })}
            {summary.otherCategoriesSpent > 0 ? (
              <Bar label="Other categories" spent={summary.otherCategoriesSpent} limit={null} currency={currency} />
            ) : null}
          </CardContent>
        </Card>
      )}

      {summary && trip.stops.length > 0 ? (
        <Card className="border-border/60 bg-card/70 backdrop-blur">
          <CardContent className="space-y-3 p-5">
            <h2 className="text-sm font-semibold">By city</h2>
            {summary.byStop.map((b) => (
              <Bar
                key={b.stopId}
                label={stopsById.get(b.stopId)?.name ?? 'City'}
                spent={b.spent}
                limit={b.budget}
                currency={currency}
              />
            ))}
            {summary.noCitySpent > 0 ? (
              <Bar label="No city" spent={summary.noCitySpent} limit={null} currency={currency} />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-border/60 bg-card/70 backdrop-blur">
        <CardContent className="p-0">
          <h2 className="px-5 pb-2 pt-5 text-sm font-semibold">Expenses on this trip</h2>
          {count === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">Nothing yet. Tap + to log one, or add some below.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {transactions.map((t) => {
                const cat = categoriesById.get(t.category_id);
                const city = cityOf(t, trip.stops);
                const pinned = !!t.trip_stop_id && city?.id === t.trip_stop_id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setEditing(t)}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-accent/40"
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg ring-1 ring-border/60"
                      style={{ backgroundColor: `${cat?.color ?? '#64748b'}22` }}
                    >
                      {cat?.icon ?? '📦'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{t.description || cat?.name || 'Expense'}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {cat?.name ?? '—'} · {formatDate(t.date)}
                        {city ? (
                          <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                            {city.name}{pinned ? ' 📍 set by you' : ''}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="nums block text-sm font-semibold">{formatMoney(Number(t.amount), currency)}</span>
                      {t.original_currency ? (
                        <span className="nums block text-xs text-amber-600/90 dark:text-amber-400/90">
                          {formatMoney(Number(t.original_amount), t.original_currency)}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {archived ? null : (
        <AddExpenses tripId={id} tripName={trip.name} currency={currency} categoriesById={categoriesById} />
      )}

      <TransactionEditDialog
        tx={editing}
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        specialEnabled={specialEnabled}
        currency={currency}
      />

      <TripEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        trip={trip}
        currency={currency}
        specialEnabled={specialEnabled}
        simpleMode={simpleMode}
      />

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {trip.name}?</DialogTitle>
            <DialogDescription>
              Your spending is never deleted. What should happen to {count === 1 ? 'its 1 expense' : `its ${count} expenses`}?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Button variant="outline" className="h-auto w-full whitespace-normal py-2" disabled={remove.isPending} onClick={() => remove.mutate('count')}>
              Count them in my monthly budget again
            </Button>
            <Button variant="outline" className="h-auto w-full whitespace-normal py-2" disabled={remove.isPending} onClick={() => remove.mutate('keep')}>
              Keep them out
            </Button>
            {data?.sourceGroup ? (
              <Button variant="outline" className="h-auto w-full whitespace-normal py-2" disabled={remove.isPending} onClick={() => remove.mutate('restore')}>
                Put them back in {data.sourceGroup.name}
              </Button>
            ) : null}
            <Button variant="ghost" className="w-full" onClick={() => setDeleting(false)} disabled={remove.isPending}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {archived ? null : (
        <QuickAddButton
          currency={currency}
          simpleMode={simpleMode}
          specialEnabled={specialEnabled}
          presetTripId={id}
        />
      )}
    </div>
  );
}
