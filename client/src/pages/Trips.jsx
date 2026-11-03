import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { QuickAddButton } from '@/components/QuickAddButton';
import { TripEditor } from '@/components/TripEditor';
import { tripHeadline } from '@/components/TripCard';
import { useApi } from '@/hooks/useApi';
import { useTrips } from '@/hooks/useTrips';
import { formatMoney } from '@/lib/format';
import { invalidateMoney } from '@/lib/invalidate';
import { tripDates } from '@/lib/trips';
import { cn } from '@/lib/utils';

function TripRow({ trip, currency, onUnarchive, unarchiving }) {
  const { text, over } = tripHeadline(trip, currency);
  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur transition-colors hover:bg-accent/30">
      <CardContent className="flex items-center gap-3 p-4">
        <Link to={`/trips/${trip.id}`} className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate font-semibold">
            <span className="truncate">{trip.name}</span>
            {trip.archivedAt ? (
              <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Archived
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">{tripDates(trip.startDate, trip.endDate)}</p>
          <p className={cn('mt-1 text-sm', over ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')}>{text}</p>
        </Link>
        {trip.archivedAt ? (
          <Button variant="outline" size="sm" onClick={() => onUnarchive(trip.id)} disabled={unarchiving}>
            Unarchive
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Section({ title, trips, ...rest }) {
  if (trips.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</h2>
      {trips.map((t) => <TripRow key={t.id} trip={t} {...rest} />)}
    </section>
  );
}

export default function Trips() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useTrips();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
  const { data: groupsData } = useQuery({
    queryKey: ['special-groups'],
    queryFn: () => api.get('/api/special-groups'),
  });
  const currency = me?.preferences?.currency ?? 'GBP';
  const specialEnabled = !!me?.preferences?.specialExpensesEnabled;
  const simpleMode = !!me?.preferences?.simpleMode;

  const [editorOpen, setEditorOpen] = useState(false);
  const [fromGroup, setFromGroup] = useState(null);
  const [choosingGroup, setChoosingGroup] = useState(false);

  const trips = data?.trips ?? [];
  const { onNow, comingUp, past } = useMemo(() => {
    const live = trips.filter((t) => !t.archivedAt);
    return {
      onNow: live.filter((t) => t.status === 'active'),
      comingUp: live
        .filter((t) => t.status === 'upcoming')
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
      past: trips
        .filter((t) => t.archivedAt || t.status === 'past')
        .sort((a, b) => b.endDate.localeCompare(a.endDate)),
    };
  }, [trips]);

  // Converted groups come back archived and empty, so they don't offer themselves again.
  const groups = (groupsData?.groups ?? []).filter((g) => !g.archivedAt && g.count > 0);

  const unarchive = useMutation({
    mutationFn: (id) => api.patch(`/api/trips/${id}`, { archived: false }),
    onSuccess: () => {
      invalidateMoney(queryClient);
      toast.success('Trip restored');
    },
    onError: (err) => toast.error(err?.message || 'Couldn’t restore the trip'),
  });

  const rowProps = { currency, onUnarchive: (id) => unarchive.mutate(id), unarchiving: unarchive.isPending };

  return (
    // pb-24, not pb-12: the floating add button would otherwise cover the last row.
    <div className="space-y-5 pb-24 animate-fade-up">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">A budget for each getaway.</p>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Trips</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {groups.length > 0 ? (
            <Button variant="outline" onClick={() => setChoosingGroup(true)} className="border-border/60 bg-card/60 backdrop-blur">
              <Star className="h-4 w-4" aria-hidden />
              Start from a special group
            </Button>
          ) : null}
          <Button
            onClick={() => {
              setFromGroup(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            New trip
          </Button>
        </div>
      </header>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : isError && !data ? (
        <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm font-medium">Couldn’t load your trips.</p>
          <p className="text-xs text-muted-foreground">{error?.message}</p>
          <button onClick={() => refetch()} className="text-sm font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      ) : trips.length === 0 ? (
        <Card className="border-border/60 bg-card/70 backdrop-blur">
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <p className="font-semibold">Planning a getaway? Give it a budget before you go ✈️</p>
            <p className="text-sm text-muted-foreground">
              Set an overall budget, one per category and one per city, and Trim tracks them as you spend.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Section title="On now" trips={onNow} {...rowProps} />
          <Section title="Coming up" trips={comingUp} {...rowProps} />
          <Section title="Past" trips={past} {...rowProps} />
        </>
      )}

      <Dialog open={choosingGroup} onOpenChange={setChoosingGroup}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start from a special group</DialogTitle>
            <DialogDescription>Its expenses move onto the new trip, and the group is archived.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  setChoosingGroup(false);
                  setFromGroup(g);
                  setEditorOpen(true);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{g.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {g.count === 1 ? '1 expense' : `${g.count} expenses`}
                  </span>
                </span>
                <span className="nums shrink-0 text-sm font-medium">{formatMoney(g.total, currency)}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <TripEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        fromGroup={fromGroup}
        currency={currency}
        specialEnabled={specialEnabled}
        simpleMode={simpleMode}
        onSaved={(trip) => trip && navigate(`/trips/${trip.id}`)}
      />

      <QuickAddButton currency={currency} simpleMode={simpleMode} specialEnabled={specialEnabled} />
    </div>
  );
}
