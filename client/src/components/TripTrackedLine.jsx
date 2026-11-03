import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
import { useTrips } from '@/hooks/useTrips';
import { cn } from '@/lib/utils';

/**
 * "Italy spending is tracked on its trip →". Explains why monthly Food looks quiet while
 * a keep-out trip is on. Stars count only while the Special setting is on, so without it
 * the spending IS in the monthly figures and this would be untrue.
 */
export function TripTrackedLine({ className }) {
  const api = useApi();
  const { data } = useTrips();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
  const trip = (data?.trips ?? []).find((t) => t.status === 'active' && !t.archivedAt && t.keepOutOfMonthly);
  if (!trip || !me?.preferences?.specialExpensesEnabled) return null;
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      <Link to={`/trips/${trip.id}`} className="hover:text-foreground hover:underline">
        {trip.name} spending is tracked on its trip →
      </Link>
    </p>
  );
}
