import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Repeat } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';

export function SubscriptionsCard({ currency }) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api.get('/api/subscriptions'),
  });

  if (isLoading) return null;

  const summary = data?.summary;
  if (!summary || summary.activeCount === 0) return null;

  const noun = summary.activeCount === 1 ? 'subscription' : 'subscriptions';

  return (
    <Link to="/subscriptions" className="block">
      <Card className="group transition-colors hover:border-primary/40">
        <CardContent className="flex items-center gap-4 p-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Repeat className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              You have {summary.activeCount} {noun},{' '}
              <span className="tabular-nums">{formatMoney(summary.activeMonthly, currency)}</span>/month —
              audit them?
            </p>
            <p className="text-xs text-muted-foreground">
              {formatMoney(summary.activeAnnual, currency)} a year on auto-pilot.
            </p>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </CardContent>
      </Card>
    </Link>
  );
}
