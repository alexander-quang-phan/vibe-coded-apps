import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';

function toneForPercent(pct) {
  if (pct < 0.85)
    return {
      bar: 'from-emerald-400 to-primary',
      hint: 'on track',
      pill: 'bg-primary/15 text-primary',
    };
  if (pct < 1)
    return {
      bar: 'from-amber-300 to-amber-500',
      hint: 'running low',
      pill: 'bg-amber-500/15 text-amber-400',
    };
  return {
    bar: 'from-rose-400 to-rose-500',
    hint: 'over — adjust next month?',
    pill: 'bg-rose-400/15 text-rose-400',
  };
}

export function BudgetAlerts({ alerts, currency }) {
  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Budget alerts
          </h3>
          {alerts.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {alerts.length} need{alerts.length === 1 ? 's' : ''} a look
            </span>
          ) : null}
        </div>

        {alerts.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-center">
            <span className="text-3xl animate-float-slow" aria-hidden>
              💚
            </span>
            <p className="mt-1 text-sm font-medium">All clear</p>
            <p className="text-xs text-muted-foreground">
              Set budgets to see heads-ups here.
            </p>
          </div>
        ) : (
          <ul className="mt-4 space-y-4">
            {alerts.map((a) => {
              const pct = Math.min(a.percent, 1.5);
              const tone = toneForPercent(a.percent);
              return (
                <li key={a.budgetId}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2 truncate">
                      <span className="text-base" aria-hidden>
                        {a.icon}
                      </span>
                      <span className="truncate font-medium">{a.name}</span>
                    </span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone.pill}`}>
                      {Math.round(a.percent * 100)}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted/70">
                    <div
                      className={`shimmer-bar h-full rounded-full bg-gradient-to-r ${tone.bar} transition-all duration-700`}
                      style={{ width: `${Math.min(100, pct * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{tone.hint}</span>
                    <span className="nums text-muted-foreground">
                      {formatMoney(a.spent, currency)} / {formatMoney(a.limit, currency)}
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
