import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, Star } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useApi } from '@/hooks/useApi';
import { useTrips } from '@/hooks/useTrips';
import { tripDates } from '@/lib/trips';
import { formatMoney, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The Dashboard's "Special expenses" panel. Phase 10 (B1), reworked for trips (17 Nov).
 *
 * The HEADER is this month's special spend, so it starts again on the 1st (in the user's
 * own time zone: it's the dashboard's `specialThisMonth`). Alex asked for that: the number
 * at a glance should be this month's.
 *
 * The ROWS are every special group and every keep-out trip at its LIFETIME total, because
 * the case they exist for is a trip paid across several months ("September 2026 Paris
 * holiday"). A row total that reset on the 1st would answer the wrong question. The rows
 * therefore won't add up to the header, and the panel says so ("All-time totals").
 *
 * A trip with "Keep this trip out of my monthly budget" off isn't listed: its spending
 * isn't special. The panel shows at £0 too, so the breakdown is always reachable; with
 * nothing to list and nothing spent, it stays out of the way.
 */
export function SpecialGroupsPanel({ currency, specialThisMonth = 0, specialOnTripsThisMonth = 0 }) {
  const api = useApi();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['special-groups'],
    queryFn: () => api.get('/api/special-groups'),
  });
  const { data: tripsData } = useTrips();
  // An archived group or trip with nothing in it (a group converted into a trip) is no use here.
  const groups = (data?.groups ?? []).filter((g) => !g.archivedAt || g.count > 0);
  const trips = (tripsData?.trips ?? [])
    .filter((t) => t.keepOutOfMonthly && (!t.archivedAt || t.count > 0))
    .sort((x, y) => y.startDate.localeCompare(x.startDate));

  if (groups.length === 0 && trips.length === 0 && specialThisMonth === 0) return null;

  const active = groups.filter((g) => !g.archivedAt);
  const archived = groups.filter((g) => g.archivedAt);

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="p-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <Star className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
            Special expenses
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="whitespace-nowrap text-sm">
              <span className="nums font-semibold text-amber-600 dark:text-amber-400">
                {formatMoney(specialThisMonth, currency)}
              </span>{' '}
              <span className="text-xs text-muted-foreground">this month</span>
            </span>
            <ChevronDown
              className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')}
              aria-hidden
            />
          </span>
        </button>

        {open ? (
          <div className="mt-3 space-y-1 border-t border-border/60 pt-3">
            {specialOnTripsThisMonth > 0 ? (
              <p className="px-2 pb-1 text-[11px] text-muted-foreground">
                <span className="nums font-medium text-foreground">{formatMoney(specialOnTripsThisMonth, currency)}</span>{' '}
                of this month’s is on trips
              </p>
            ) : null}

            {groups.length === 0 && trips.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No groups yet — tick "Special expense" when logging one and you can file it under an
                occasion. Going away?{' '}
                <Link to="/trips" className="font-medium text-primary hover:underline">Give it its own trip →</Link>
              </p>
            ) : (
              <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                All-time totals
              </p>
            )}

            {trips.map((t) => (
              <Link
                key={t.id}
                to={`/trips/${t.id}`}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/50"
              >
                <span className="min-w-0">
                  <span className={cn('block truncate text-sm', t.archivedAt && 'text-muted-foreground line-through')}>
                    ✈️ {t.name} <span className="text-xs text-muted-foreground">(trip)</span>
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{tripDates(t.startDate, t.endDate)}</span>
                </span>
                <span className="nums shrink-0 text-sm font-medium">{formatMoney(t.spent, currency)}</span>
              </Link>
            ))}

            {[...active, ...archived].map((g) => (
              <Link
                key={g.id}
                to={`/transactions?specialGroup=${g.id}`}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/50"
              >
                <span className="min-w-0">
                  <span className={cn('block truncate text-sm', g.archivedAt && 'text-muted-foreground line-through')}>
                    {g.name}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {g.count === 1 ? '1 expense' : `${g.count} expenses`}
                    {g.firstDate ? ` · from ${formatDate(g.firstDate)}` : ''}
                  </span>
                </span>
                <span className="nums shrink-0 text-sm font-medium">
                  {formatMoney(g.total, currency)}
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
