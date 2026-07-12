import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';

/**
 * Simple-mode "This month" card (Task 6.5). One big number — what's left of
 * the monthly limit — with a gradient bar. When no limit is set yet, the same
 * slot renders the inline "set your limit" form so the user is never bounced
 * to Settings.
 */
export function SimpleMonthCard({ spent, currency, monthlyLimit }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [limitStr, setLimitStr] = useState('');

  const limitMutation = useMutation({
    mutationFn: (monthlyLimit) => api.patch('/api/me', { monthlyLimit }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Monthly limit set', { description: 'One number. That’s the whole game.' });
    },
    onError: (err) => toast.error(err?.message || 'Could not save'),
  });

  const symbol = formatMoney(0, currency).replace(/\d|[.,]/g, '').trim() || '$';

  if (monthlyLimit === null || monthlyLimit === undefined) {
    const limit = Number(limitStr);
    const valid = limitStr !== '' && Number.isFinite(limit) && limit > 0;
    return (
      <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
        <CardContent className="p-6">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            This month
          </h3>
          <p className="mt-3 text-sm font-medium">Set your monthly limit</p>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            One number to stay under — that's all simple mode tracks. You can
            change it here any time.
          </p>
          <form
            className="mt-4 flex max-w-sm gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !limitMutation.isPending) limitMutation.mutate(limit);
            }}
          >
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base font-semibold text-muted-foreground">
                {symbol}
              </span>
              <Label htmlFor="simple-limit" className="sr-only">
                Monthly limit
              </Label>
              <Input
                id="simple-limit"
                className="no-spin h-11 pl-8 text-lg font-semibold"
                type="number"
                inputMode="decimal"
                step="1"
                min="0"
                placeholder="1000"
                value={limitStr}
                onChange={(e) => setLimitStr(e.target.value)}
                autoComplete="off"
              />
            </div>
            <Button type="submit" className="h-11" disabled={!valid || limitMutation.isPending}>
              <Check className="mr-1.5 h-4 w-4" aria-hidden />
              Set it
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  const left = monthlyLimit - spent;
  const pct = monthlyLimit > 0 ? Math.min(spent / monthlyLimit, 1.5) : 0;
  const over = left < 0;
  const tone = over
    ? 'from-rose-400 to-rose-500'
    : pct > 0.9
      ? 'from-amber-300 to-amber-500'
      : 'from-emerald-400 to-primary';

  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl"
      />
      <CardContent className="relative p-6">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            This month
          </h3>
          <span className="nums text-xs text-muted-foreground">
            {formatMoney(spent, currency)} of {formatMoney(monthlyLimit, currency)} spent
          </span>
        </div>

        <p className="nums mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">
          {over ? (
            <>
              {formatMoney(Math.abs(left), currency)}{' '}
              <span className="text-lg font-semibold text-rose-400">over</span>
            </>
          ) : (
            <>
              <span className="text-gradient">{formatMoney(left, currency)}</span>{' '}
              <span className="text-lg font-semibold text-muted-foreground">left</span>
            </>
          )}
        </p>

        <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted/70">
          <div
            className={`shimmer-bar h-full rounded-full bg-gradient-to-r ${tone} transition-all duration-700`}
            style={{ width: `${Math.min(100, pct * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {over
            ? 'Over this month — want to adjust next month?'
            : pct > 0.9
              ? 'Close to the line — glide it home.'
              : 'Comfortably on track.'}
        </p>
      </CardContent>
    </Card>
  );
}
