import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HelpCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

const VERDICT_TONES = {
  'Comfortably yes': 'text-primary',
  'Tight but yes': 'text-amber-400',
  'Would push you over': 'text-rose-400',
};

/**
 * "Can I afford this?" (Task 6.4) — stress-test a purchase before making it.
 * Debounced 300ms; pure read, nothing is logged. Hidden in simple mode.
 */
export function AffordabilityCheck({ currency }) {
  const api = useApi();
  const [amountStr, setAmountStr] = useState('');
  const [categoryId, setCategoryId] = useState(null);
  const [debounced, setDebounced] = useState(null);
  const timerRef = useRef(null);

  const amount = Number(amountStr);
  const amountValid = amountStr !== '' && Number.isFinite(amount) && amount > 0;

  const { data: categoriesData } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
  });
  const expenseCategories = useMemo(
    () => (categoriesData?.categories ?? []).filter((c) => c.type === 'expense'),
    [categoriesData],
  );

  // Same queryKey as MonthProjection — cache is shared, no extra request.
  const { data: proj } = useQuery({
    queryKey: ['projections', 'month'],
    queryFn: () => api.get('/api/projections/month'),
  });
  const pace = proj?.pace ?? null;

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!amountValid) {
      setDebounced(null);
      return;
    }
    timerRef.current = setTimeout(
      () => setDebounced({ amount, categoryId }),
      300,
    );
    return () => clearTimeout(timerRef.current);
  }, [amount, amountValid, categoryId]);

  const { data: result, isFetching } = useQuery({
    queryKey: ['affordability', debounced],
    queryFn: () => api.post('/api/affordability', debounced),
    enabled: debounced !== null,
    staleTime: 10_000,
  });

  const showResult = amountValid && result && !isFetching;
  const symbol = formatMoney(0, currency).replace(/\d|[.,]/g, '').trim() || '$';

  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <HelpCircle className="h-3.5 w-3.5 text-primary" aria-hidden />
            Can I afford this?
          </h3>
          <span className="text-[11px] text-muted-foreground">
            Just checking — nothing gets logged.
          </span>
        </div>

        {pace ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {pace.delta >= 0 ? (
              <span className="text-primary">✓</span>
            ) : (
              <span className="text-amber-400">◷</span>
            )}{' '}
            By day {proj.daysElapsed}, about {formatMoney(pace.target, currency)} of your budget
            would typically be used — you're at{' '}
            <span className={cn('nums font-medium', pace.delta >= 0 ? 'text-primary' : 'text-amber-400')}>
              {formatMoney(pace.spent, currency)}
            </span>
            {pace.delta < 0 ? ' — a touch ahead of pace, plenty of month left.' : '.'}
          </p>
        ) : null}

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative sm:w-40">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base font-semibold text-muted-foreground">
              {symbol}
            </span>
            <Input
              aria-label="Hypothetical amount"
              className="no-spin h-11 pl-8 text-lg font-semibold"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {expenseCategories.map((c) => {
              const active = c.id === categoryId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategoryId(active ? null : c.id)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'border-primary/60 bg-primary/15 text-primary'
                      : 'border-border/70 bg-secondary/40 text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span aria-hidden>{c.icon}</span>
                  {c.name}
                </button>
              );
            })}
          </div>
        </div>

        {showResult ? (
          <div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className={cn('text-sm font-semibold', VERDICT_TONES[result.verdict] ?? 'text-primary')}>
              {result.verdict}
            </p>
            <div className="space-y-0.5 text-xs text-muted-foreground sm:text-right">
              {result.categoryRemaining !== null ? (
                <p className="nums">
                  {formatMoney(Math.abs(result.categoryRemaining), currency)}{' '}
                  {result.categoryRemaining >= 0 ? 'left in this category after it' : 'past this category’s budget'}
                </p>
              ) : null}
              {result.totalRemaining !== null ? (
                <p className="nums">
                  {formatMoney(Math.abs(result.totalRemaining), currency)}{' '}
                  {result.totalRemaining >= 0 ? 'left across all budgets' : 'past your combined budgets'}
                </p>
              ) : (
                <p>No monthly budgets yet — set one for a sharper answer.</p>
              )}
              {result.goal && result.goalImpactDays !== null ? (
                <p>
                  Delays {result.goal.emoji ? `${result.goal.emoji} ` : ''}
                  {result.goal.name} by ~{result.goalImpactDays}{' '}
                  {result.goalImpactDays === 1 ? 'day' : 'days'} at your current pace
                </p>
              ) : null}
            </div>
          </div>
        ) : amountValid && isFetching ? (
          <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Crunching…
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
