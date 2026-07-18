import { Link } from 'react-router-dom';
import { Star } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Phase 9.4 — one row per month, newest first; rows link to the
 *  Transactions page filtered to that month. */
export function MonthlyHistory({ series, currency, showSpecial }) {
  // Trim leading pre-signup months only — zero months inside an active history stay.
  const firstWithData = series.findIndex((m) => m.income > 0 || m.expenses > 0);
  const months = firstWithData === -1 ? [] : series.slice(firstWithData).reverse();
  if (months.length === 0) return null;
  const thisYm = new Date().toISOString().slice(0, 7);

  return (
    <Card className="lift border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="p-5 sm:p-6">
        <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Monthly history
        </h3>
        <div className="mt-3 divide-y divide-border/60">
          {months.map((m) => (
            <Link
              key={m.ym}
              to={`/transactions?month=${m.ym}`}
              className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-foreground"
            >
              <span className="w-24 shrink-0 font-medium">
                {m.label} {m.ym.slice(0, 4)}
                {m.ym === thisYm ? (
                  <span className="ml-1 text-[10px] text-muted-foreground">so far</span>
                ) : null}
              </span>
              <span className="nums flex-1 text-right text-muted-foreground">
                −{formatMoney(m.expenses, currency)}
              </span>
              <span className="nums hidden flex-1 text-right text-muted-foreground sm:block">
                +{formatMoney(m.income, currency)}
              </span>
              <span className={cn('nums w-24 shrink-0 text-right font-medium', m.net >= 0 ? 'text-primary' : 'text-amber-400')}>
                {formatMoney(m.net, currency)}
              </span>
              {showSpecial ? (
                <span className="nums hidden w-20 shrink-0 items-center justify-end gap-1 text-right text-xs text-amber-400 sm:flex">
                  {m.special > 0 ? (
                    <>
                      <Star className="h-3 w-3" aria-hidden /> {formatMoney(m.special, currency)}
                    </>
                  ) : null}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
