import { Link } from 'react-router-dom';
import { Plane } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useTrips } from '@/hooks/useTrips';
import { formatMoney } from '@/lib/format';
import { dashboardTrips } from '@/lib/trips';

const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** "Day 3 of 8", "Starts in 4 days" or "Ended". */
export function tripWhen(trip) {
  if (trip.status === 'active') return `Day ${trip.dayOfTrip} of ${trip.length}`;
  if (trip.status === 'upcoming') return `Starts in ${days(trip.daysUntilStart)}`;
  return 'Ended';
}

/**
 * The one-line money summary on a Trips page card. Amber, never red, when over: a trip
 * that ran over deserves a bigger budget next time, not a telling-off.
 */
export function tripHeadline(trip, currency) {
  const money = (n) => formatMoney(n, currency);
  const budgeted = trip.totalBudget !== null;
  if (trip.status === 'upcoming') return { text: tripWhen(trip), over: false };
  if (!budgeted) return { text: `${money(trip.spent)} spent`, over: false };
  if (trip.status === 'past') {
    return trip.overBy > 0
      ? { text: `Came in ${money(trip.overBy)} over — worth a bigger budget next time?`, over: true }
      : { text: `Came in ${money(trip.remaining)} under 🎉`, over: false };
  }
  return trip.overBy > 0
    ? { text: `${money(trip.overBy)} over`, over: true }
    : { text: `${money(trip.remaining)} left · ${money(trip.perDayLeft)}/day`, over: false };
}

function DashboardTripCard({ trip, currency }) {
  const money = (n) => formatMoney(n, currency);
  let line = null;
  if (trip.totalBudget !== null) {
    if (trip.overBy > 0) line = `${money(trip.overBy)} over`;
    else if (trip.status === 'active') line = `${money(trip.remaining)} left · ${money(trip.perDayLeft)}/day`;
    else line = `${money(trip.remaining)} left`;
  }
  return (
    <Link to={`/trips/${trip.id}`} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card className="border-border/60 bg-card/70 backdrop-blur transition-colors hover:bg-accent/40">
        <CardContent className="flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-400/10 text-sky-700 ring-1 ring-sky-400/30 dark:text-sky-300">
            <Plane className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{trip.name}</p>
            <p className="text-xs text-muted-foreground">{tripWhen(trip)}</p>
          </div>
          {line ? (
            <p className={`nums shrink-0 text-right text-sm font-semibold ${trip.overBy > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>
              {line}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </Link>
  );
}

/** Under the Dashboard hero: trips on now or starting within a week. */
export function TripCards({ currency }) {
  const { data } = useTrips();
  const trips = dashboardTrips(data?.trips ?? []);
  if (trips.length === 0) return null;
  return (
    <div className="space-y-2">
      {trips.map((t) => <DashboardTripCard key={t.id} trip={t} currency={currency} />)}
    </div>
  );
}
