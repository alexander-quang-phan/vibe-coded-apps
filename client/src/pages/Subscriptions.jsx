import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/useApi';
import { SubscriptionRow } from '@/components/SubscriptionRow';
import { formatMoney } from '@/lib/format';

function SummaryCard({ summary, currency }) {
  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
        <Stat label="Active" value={summary.activeCount} />
        <Stat
          label="Per month"
          value={formatMoney(summary.activeMonthly, currency)}
          emphasis
        />
        <Stat label="Per year" value={formatMoney(summary.activeAnnual, currency)} />
        <Stat
          label="Saved (cancelled)"
          value={formatMoney(summary.cancelledAnnual, currency)}
          accent
        />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, emphasis, accent }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={
          accent
            ? 'truncate text-base font-semibold tabular-nums text-primary'
            : emphasis
              ? 'truncate text-base font-semibold tabular-nums'
              : 'truncate text-base tabular-nums'
        }
      >
        {value}
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <span className="text-4xl" aria-hidden>🔁</span>
        <div className="space-y-1">
          <p className="font-medium">No subscriptions detected yet</p>
          <p className="text-sm text-muted-foreground">
            Once you've got 3+ regular charges from the same merchant, they'll show up here so you can audit them.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Subscriptions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [pendingKey, setPendingKey] = useState(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api.get('/api/subscriptions'),
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
  const currency = me?.preferences?.currency ?? 'GBP';

  const subscriptions = data?.subscriptions ?? [];
  const summary = data?.summary ?? {
    activeCount: 0,
    cancelledCount: 0,
    activeMonthly: 0,
    activeAnnual: 0,
    cancelledMonthly: 0,
    cancelledAnnual: 0,
  };

  const { active, cancelled } = useMemo(() => {
    const a = [];
    const c = [];
    for (const s of subscriptions) {
      if (s.status === 'cancelled') c.push(s);
      else a.push(s);
    }
    return { active: a, cancelled: c };
  }, [subscriptions]);

  const toggleMutation = useMutation({
    mutationFn: ({ merchantKey, status }) =>
      api.patch(`/api/subscriptions/${encodeURIComponent(merchantKey)}`, { status }),
    onMutate: ({ merchantKey }) => setPendingKey(merchantKey),
    onSuccess: (_data, { sub, status }) => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      if (status === 'cancelled') {
        toast.success(
          `${sub.name} cancelled — that's ${formatMoney(sub.annualCost, currency)} a year back. 🎉`,
        );
      } else {
        toast.success(`${sub.name} marked active.`);
      }
    },
    onError: (err) => toast.error(err?.message || 'Could not update subscription'),
    onSettled: () => setPendingKey(null),
  });

  function handleToggle(sub, nextStatus) {
    toggleMutation.mutate({ merchantKey: sub.merchantKey, status: nextStatus, sub });
  }

  return (
    <div className="space-y-5 pb-12">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Recurring charges Trim has spotted in your transactions.
        </p>
        <h1 className="text-3xl font-bold tracking-tight">Subscriptions</h1>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : isError ? (
        <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm font-medium">Couldn't load your subscriptions.</p>
          <p className="text-xs text-muted-foreground">{error?.message}</p>
          <button onClick={() => refetch()} className="text-sm font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      ) : subscriptions.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SummaryCard summary={summary} currency={currency} />

          {active.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
                <span className="text-3xl" aria-hidden>✨</span>
                <p className="font-medium">All audited</p>
                <p className="text-sm text-muted-foreground">
                  No active subs left — see your cancelled list below.
                </p>
              </CardContent>
            </Card>
          ) : (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Active</h2>
              <div className="space-y-3">
                {active.map((sub) => (
                  <SubscriptionRow
                    key={sub.merchantKey}
                    subscription={sub}
                    currency={currency}
                    onToggle={handleToggle}
                    pending={pendingKey === sub.merchantKey}
                  />
                ))}
              </div>
            </section>
          )}

          {cancelled.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Cancelled · saving {formatMoney(summary.cancelledAnnual, currency)} a year
              </h2>
              <div className="space-y-3">
                {cancelled.map((sub) => (
                  <SubscriptionRow
                    key={sub.merchantKey}
                    subscription={sub}
                    currency={currency}
                    onToggle={handleToggle}
                    pending={pendingKey === sub.merchantKey}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
