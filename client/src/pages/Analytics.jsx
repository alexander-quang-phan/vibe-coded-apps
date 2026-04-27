import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';

function AnalyticsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-20" />
      <Skeleton className="h-72" />
      <Skeleton className="h-60" />
    </div>
  );
}

function compactMoney(v, currency) {
  return formatMoney(v, currency, { compact: true });
}

export default function Analytics() {
  const api = useApi();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics', 6],
    queryFn: () => api.get('/api/analytics?months=6'),
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
  const currency = me?.preferences?.currency ?? 'GBP';

  if (isLoading) return <AnalyticsSkeleton />;
  if (isError) {
    return (
      <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm font-medium">Couldn't load analytics.</p>
        <p className="text-xs text-muted-foreground">{error?.message}</p>
        <button onClick={() => refetch()} className="text-sm font-medium text-primary hover:underline">
          Try again
        </button>
      </div>
    );
  }

  const { series, topCategories, mom } = data;
  const pct = mom.deltaPct;
  const delta = pct === null ? null : pct;
  const trendingUp = delta !== null && delta > 0;

  return (
    <div className="space-y-5 pb-12 animate-fade-up">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">Six-month view. See where the money moves.</p>
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Analytics</h1>
      </header>

      <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 -right-12 h-44 w-44 rounded-full bg-primary/15 blur-3xl"
        />
        <CardContent className="relative flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              This month
            </p>
            <p className="nums text-3xl font-extrabold tracking-tight text-gradient">
              {formatMoney(mom.thisMonth, currency)}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Last month
            </p>
            <p className="nums text-2xl font-semibold text-muted-foreground">
              {formatMoney(mom.lastMonth, currency)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Change
            </p>
            {delta === null ? (
              <p className="text-2xl font-semibold">—</p>
            ) : (
              <div
                className={`nums flex items-center justify-end gap-1 rounded-full px-3 py-0.5 text-lg font-bold ${
                  trendingUp
                    ? 'bg-rose-400/10 text-rose-400'
                    : 'bg-primary/15 text-primary'
                }`}
              >
                {trendingUp ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                {trendingUp ? '+' : ''}
                {delta}%
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="lift border-border/60 bg-card/70 backdrop-blur">
        <CardContent className="p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Income vs. Expenses
          </h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="label"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => compactMoney(v, currency)}
                />
                <Tooltip
                  formatter={(v) => formatMoney(v, currency)}
                  contentStyle={{
                    backgroundColor: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                />
                <Line
                  type="monotone"
                  dataKey="income"
                  name="Income"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 3, fill: 'hsl(var(--primary))' }}
                  activeDot={{ r: 5 }}
                />
                <Line
                  type="monotone"
                  dataKey="expenses"
                  name="Expenses"
                  stroke="#fb7185"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#fb7185' }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex items-center justify-center gap-6 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-primary" /> Income
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: '#fb7185' }} /> Expenses
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="lift border-border/60 bg-card/70 backdrop-blur">
        <CardContent className="p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Top categories this month
          </h2>
          {topCategories.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No expenses logged yet this month.
            </p>
          ) : (
            <div className="space-y-3">
              {topCategories.map((c) => {
                const max = topCategories[0].total;
                const pct = max > 0 ? Math.round((c.total / max) * 100) : 0;
                const color = c.color || '#10b981';
                return (
                  <div key={c.categoryId}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className="text-lg">{c.icon}</span>
                        <span className="font-medium">{c.name}</span>
                      </span>
                      <span className="nums tabular-nums text-muted-foreground">
                        {formatMoney(c.total, currency)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted/70">
                      <div
                        className="shimmer-bar h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${pct}%`,
                          background: `linear-gradient(90deg, ${color}, ${color}cc)`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
