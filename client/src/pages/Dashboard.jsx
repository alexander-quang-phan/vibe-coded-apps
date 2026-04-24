import { useQuery } from '@tanstack/react-query';
import { Flame, Wallet, Shield } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { StatCard } from '@/components/StatCard';
import { LevelCard } from '@/components/LevelCard';
import { CategoryDonut } from '@/components/CategoryDonut';
import { RecentTransactions } from '@/components/RecentTransactions';
import { BudgetAlerts } from '@/components/BudgetAlerts';
import { QuickAddButton } from '@/components/QuickAddButton';
import { formatMoney } from '@/lib/format';

function DashboardSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-7 w-48 rounded-md bg-muted" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-muted" />
        ))}
      </div>
      <div className="h-64 rounded-xl bg-muted" />
      <div className="h-64 rounded-xl bg-muted" />
    </div>
  );
}

export default function Dashboard() {
  const api = useApi();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/api/dashboard'),
  });

  if (isLoading) return <DashboardSkeleton />;

  if (isError) {
    return (
      <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
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
  const { month, categoryBreakdown, recentTransactions, budgetAlerts, stats } = data;

  const balancePrefix = month.balance >= 0 ? '+' : '−';
  const balanceDisplay = `${balancePrefix}${formatMoney(Math.abs(month.balance), currency)}`;

  return (
    <div className="space-y-5 pb-24">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">Welcome back — here's this month.</p>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Balance"
          value={balanceDisplay}
          sub={`${formatMoney(month.income, currency)} in · ${formatMoney(month.expenses, currency)} out`}
          icon={<Wallet className="h-5 w-5" />}
          className="col-span-2 sm:col-span-1"
        />
        <StatCard
          label="Streak"
          value={`${stats.currentStreak} ${stats.currentStreak === 1 ? 'day' : 'days'}`}
          sub={
            stats.shields > 0
              ? `🛡️ ${stats.shields} shield${stats.shields > 1 ? 's' : ''} banked`
              : `Longest: ${stats.longestStreak}`
          }
          icon={<Flame className="h-5 w-5" />}
          accent="streak"
        />
        <StatCard
          label="Shields"
          value={stats.shields}
          sub="Earn 1 per 7-day streak"
          icon={<Shield className="h-5 w-5" />}
          accent="muted"
          className="hidden sm:block"
        />
      </section>

      <LevelCard
        level={stats.level}
        title={stats.title}
        xpIntoLevel={stats.xpIntoLevel}
        xpForNextLevel={stats.xpForNextLevel}
      />

      <section className="grid gap-4 lg:grid-cols-2">
        <CategoryDonut
          breakdown={categoryBreakdown}
          totalExpenses={month.expenses}
          currency={currency}
        />
        <BudgetAlerts alerts={budgetAlerts} currency={currency} />
      </section>

      <RecentTransactions transactions={recentTransactions} currency={currency} />

      <QuickAddButton currency={currency} />
    </div>
  );
}
