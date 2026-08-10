import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HelpCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { MoneyInput, isValidMoney } from '@/components/ui/money-input';
import { PaceLine } from '@/components/PaceLine';
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
export function AffordabilityCheck({ currency, includeSpecial = false }) {
  const api = useApi();
  const [amountStr, setAmountStr] = useState('');
  const [categoryId, setCategoryId] = useState(null);
  const [debounced, setDebounced] = useState(null);
  const timerRef = useRef(null);

  const amount = Number(amountStr);
  const amountValid = isValidMoney(amountStr);

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
      () => setDebounced({ amount, categoryId, includeSpecial }),
      300,
    );
    return () => clearTimeout(timerRef.current);
    // includeSpecial is a dependency: flipping the hero's toggle must re-ask the
    // question on the new basis. It also lands in the payload, so the
    // ['affordability', debounced] cache key changes and a refetch happens.
  }, [amount, amountValid, categoryId, includeSpecial]);

  const { data: result, isFetching } = useQuery({
    queryKey: ['affordability', debounced],
    queryFn: () => api.post('/api/affordability', debounced),
    enabled: debounced !== null,
    staleTime: 10_000,
  });

  const showResult = amountValid && result && !isFetching;

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

        <PaceLine
          pace={pace}
          daysElapsed={proj?.daysElapsed}
          currency={currency}
          className="mt-2"
        />

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <MoneyInput
            aria-label="Hypothetical amount"
            currency={currency}
            showSymbol
            containerClassName="sm:w-40"
            className="no-spin h-11 pl-8 text-lg font-semibold"
            value={amountStr}
            onValueChange={setAmountStr}
          />

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
                  {result.totalSource === 'overall'
                    ? result.totalRemaining >= 0
                      ? 'left in your monthly budget'
                      : 'past your monthly budget'
                    : result.totalRemaining >= 0
                      ? 'left across all budgets'
                      : 'past your combined budgets'}
                </p>
              ) : (
                <p>No monthly budget yet — set one for a sharper answer.</p>
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
