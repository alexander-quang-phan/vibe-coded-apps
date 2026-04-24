import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';

function toneForPercent(pct) {
  if (pct < 0.85) return { ring: '#10b981', bar: 'bg-emerald-500', hint: 'on track' };
  if (pct < 1) return { ring: '#f59e0b', bar: 'bg-amber-500', hint: 'running low' };
  return { ring: '#f43f5e', bar: 'bg-rose-500', hint: 'over — adjust next month?' };
}

export function BudgetAlerts({ alerts, currency }) {
  return (
    <Card>
      <CardContent className="p-6">
        <h3 className="text-sm font-medium text-muted-foreground">Budget alerts</h3>

        {alerts.length === 0 ? (
          <div className="flex h-28 flex-col items-center justify-center text-center">
            <p className="text-sm font-medium">No alerts 💚</p>
            <p className="text-xs text-muted-foreground">
              Set budgets in the Budgets page to see heads-ups here.
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
                      <span className="text-base">{a.icon}</span>
                      <span className="truncate font-medium">{a.name}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatMoney(a.spent, currency)} / {formatMoney(a.limit, currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${tone.bar} transition-all`}
                      style={{ width: `${Math.min(100, pct * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {Math.round(a.percent * 100)}% used · {tone.hint}
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
