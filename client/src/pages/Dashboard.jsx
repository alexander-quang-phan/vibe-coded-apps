import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownLeft, ArrowUpRight, Sparkles, Star } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { AffordabilityCheck } from '@/components/AffordabilityCheck';
import { PulseStrip } from '@/components/PulseStrip';
import { CategoryDonut } from '@/components/CategoryDonut';
import { SimpleMonthCard } from '@/components/SimpleMonthCard';
import { RecentTransactions } from '@/components/RecentTransactions';
import { MonthProjection } from '@/components/MonthProjection';
import { WinsFeed } from '@/components/WinsFeed';
import { QuickAddButton } from '@/components/QuickAddButton';
import { formatMoney } from '@/lib/format';

function DashboardSkeleton() {
  return (
    <div className="animate-pulse space-y-5">
      <div className="space-y-2">
        <div className="h-4 w-32 rounded-md bg-muted" />
        <div className="h-9 w-56 rounded-md bg-muted" />
      </div>
      <div className="h-44 rounded-2xl bg-muted" />
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl bg-muted" />
        ))}
      </div>
      <div className="h-28 rounded-2xl bg-muted" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-64 rounded-2xl bg-muted" />
        <div className="h-64 rounded-2xl bg-muted" />
      </div>
    </div>
  );
}

/**
 * Animate a number from 0 → target. Pure RAF loop, eases out.
 * Respects prefers-reduced-motion by snapping to the value.
 */
function useCountUp(target, duration = 900) {
  const [value, setValue] = useState(0);
  const startedAt = useRef(null);
  const fromRef = useRef(0);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setValue(target);
      return;
    }
    fromRef.current = value;
    startedAt.current = null;
    let raf = 0;
    const tick = (t) => {
      if (startedAt.current === null) startedAt.current = t;
      const elapsed = t - startedAt.current;
      const p = Math.min(1, elapsed / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(fromRef.current + (target - fromRef.current) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return value;
}

function greetingFor(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return 'Burning the midnight oil';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Up late';
}

function HeroBalance({ income, expenses, balance, currency, displayName, specialThisMonth = 0 }) {
  const animated = useCountUp(Math.abs(balance));
  const positive = balance >= 0;
  const sign = positive ? '' : '−';
  const display = `${sign}${formatMoney(animated, currency)}`;

  return (
    <section className="relative animate-fade-up">
      <div className="gradient-border sheen-mask relative overflow-hidden rounded-2xl border border-border/60 bg-card/70 p-6 shadow-xl shadow-primary/[0.06] backdrop-blur sm:p-8">
        {/* Soft radial accent in the corner */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-primary/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -left-10 h-56 w-56 rounded-full bg-emerald-400/10 blur-3xl"
        />

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              {displayName ? `${greetingFor()}, ${displayName}` : greetingFor()}
            </p>
            <p className="text-sm text-muted-foreground">Net this month</p>
            <p
              className={
                'nums text-5xl font-extrabold leading-none tracking-tight sm:text-7xl ' +
                (positive ? 'text-gradient' : 'text-foreground')
              }
            >
              {display}
            </p>
          </div>

          <div className="flex gap-2 self-stretch sm:self-end">
            <div className="flex-1 rounded-xl border border-border/70 bg-background/40 px-4 py-3 backdrop-blur-sm sm:flex-initial">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <ArrowDownLeft className="h-3 w-3" strokeWidth={3} />
                </span>
                In
              </div>
              <p className="mt-1 nums text-base font-semibold text-primary">
                {formatMoney(income, currency)}
              </p>
            </div>
            <div className="flex-1 rounded-xl border border-border/70 bg-background/40 px-4 py-3 backdrop-blur-sm sm:flex-initial">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-400/15 text-rose-400">
                  <ArrowUpRight className="h-3 w-3" strokeWidth={3} />
                </span>
                Out
              </div>
              <p className="mt-1 nums text-base font-semibold">
                {formatMoney(expenses, currency)}
              </p>
            </div>
            {specialThisMonth > 0 ? (
              <div className="flex-1 rounded-xl border border-border/70 bg-background/40 px-4 py-3 backdrop-blur-sm sm:flex-initial">
                <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/15 text-amber-400">
                    <Star className="h-3 w-3" strokeWidth={3} />
                  </span>
                  Special
                </div>
                <p className="mt-1 nums text-base font-semibold text-amber-400">
                  {formatMoney(specialThisMonth, currency)}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Dashboard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/api/dashboard'),
  });

  const deleteTxMutation = useMutation({
    mutationFn: (id) => api.del(`/api/transactions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      queryClient.invalidateQueries({ queryKey: ['projections'] });
      toast.success('Transaction removed');
    },
    onError: (err) => toast.error(err?.message || 'Could not delete'),
  });

  if (isLoading) return <DashboardSkeleton />;

  if (isError) {
    return (
      <div className="space-y-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm font-medium">Couldn't load your dashboard.</p>
        <p className="text-xs text-muted-foreground">{error?.message}</p>
        <button
          onClick={() => refetch()}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  const currency = data.preferences.currency;
  const displayName = data.preferences.displayName;
  const simpleMode = data.preferences.simpleMode;
  const specialEnabled = data.preferences.specialExpensesEnabled;
  const { month, categoryBreakdown, recentTransactions, budgetAlerts, stats } = data;

  return (
    <div className="space-y-6 pb-24">
      <HeroBalance
        income={month.income}
        expenses={month.expenses}
        balance={month.balance}
        currency={currency}
        displayName={displayName}
        specialThisMonth={month.specialThisMonth ?? 0}
      />

      {simpleMode ? null : (
        <div className="animate-fade-up" style={{ animationDelay: '40ms' }}>
          <AffordabilityCheck currency={currency} />
        </div>
      )}

      <div className="animate-fade-up" style={{ animationDelay: '60ms' }}>
        <PulseStrip stats={stats} transactionCount={month.transactionCount} />
      </div>

      {simpleMode ? (
        <div className="animate-fade-up" style={{ animationDelay: '150ms' }}>
          <SimpleMonthCard
            spent={month.expenses}
            currency={currency}
            monthlyLimit={data.preferences.monthlyLimit ?? null}
          />
        </div>
      ) : (
        <div className="animate-fade-up" style={{ animationDelay: '150ms' }}>
          <MonthProjection currency={currency} />
        </div>
      )}

      {simpleMode ? null : (
        <div className="animate-fade-up" style={{ animationDelay: '200ms' }}>
          <CategoryDonut
            breakdown={categoryBreakdown}
            totalExpenses={month.expenses}
            currency={currency}
            alerts={budgetAlerts}
          />
        </div>
      )}

      <section
        className="grid gap-4 animate-fade-up lg:grid-cols-2"
        style={{ animationDelay: '240ms' }}
      >
        <RecentTransactions
          transactions={recentTransactions}
          currency={currency}
          onDelete={(t) => deleteTxMutation.mutate(t.id)}
          pendingDeleteId={deleteTxMutation.isPending ? deleteTxMutation.variables : null}
        />
        <WinsFeed variant="peek" />
      </section>

      <QuickAddButton currency={currency} simpleMode={simpleMode} specialEnabled={specialEnabled} />
    </div>
  );
}
