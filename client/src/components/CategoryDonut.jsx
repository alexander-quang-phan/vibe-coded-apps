import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
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
      hint: 'getting close',
      pill: 'bg-amber-500/15 text-amber-400',
    };
  return {
    bar: 'from-rose-400 to-rose-500',
    hint: 'over — adjust next month?',
    pill: 'bg-rose-400/15 text-rose-400',
  };
}

/**
 * "This month by category" — donut + top categories, with any at-risk
 * budgets folded in underneath (Task 6.A merged the old BudgetAlerts card
 * into this one so the Dashboard reads as one story, not two cards).
 */
export function CategoryDonut({ breakdown, totalExpenses, currency, alerts = [] }) {
  const hasData = breakdown.length > 0 && totalExpenses > 0;
  const top = breakdown[0];

  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      {top ? (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 -right-16 h-44 w-44 rounded-full blur-3xl opacity-50"
          style={{ background: top.color }}
        />
      ) : null}

      <CardContent className="relative p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            This month by category
          </h3>
          {hasData ? (
            <span className="text-xs text-muted-foreground">
              {breakdown.length} active
            </span>
          ) : null}
        </div>

        {!hasData ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
            <div className="text-5xl animate-float-slow">🌱</div>
            <p className="text-sm font-medium">No expenses yet this month</p>
            <p className="text-xs text-muted-foreground">
              Log a transaction and we'll chart it here.
            </p>
          </div>
        ) : (
          <div className="mt-5 grid gap-6 lg:grid-cols-[12rem_1fr_1fr] lg:items-start">
            <div className="relative mx-auto h-48 w-48 shrink-0 lg:mx-0">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={breakdown}
                    dataKey="total"
                    nameKey="name"
                    innerRadius={62}
                    outerRadius={88}
                    stroke="hsl(var(--card))"
                    strokeWidth={3}
                    paddingAngle={2}
                    isAnimationActive
                    animationDuration={700}
                  >
                    {breakdown.map((entry) => (
                      <Cell key={entry.categoryId} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Total
                </p>
                <p className="nums text-xl font-bold">
                  {formatMoney(totalExpenses, currency)}
                </p>
              </div>
            </div>

            <ul className="space-y-2.5">
              {breakdown.slice(0, 5).map((c) => {
                const pct = Math.round(c.percentOfExpenses * 100);
                return (
                  <li key={c.categoryId} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="text-base" aria-hidden>
                          {c.icon}
                        </span>
                        <span className="truncate font-medium">{c.name}</span>
                      </span>
                      <span className="nums shrink-0 text-muted-foreground">
                        {formatMoney(c.total, currency)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted/60">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, backgroundColor: c.color }}
                        />
                      </div>
                      <span className="nums w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                        {pct}%
                      </span>
                    </div>
                  </li>
                );
              })}
              {breakdown.length > 5 ? (
                <li className="pt-1 text-xs text-muted-foreground">
                  +{breakdown.length - 5} more
                </li>
              ) : null}
            </ul>

            <div className="border-t border-border/60 pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Budgets to watch
              </h4>
              {alerts.length === 0 ? (
                <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-primary/[0.07] px-3 py-2.5">
                  <span className="text-lg" aria-hidden>
                    💚
                  </span>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Everything's inside its budget. Nothing needs a look.
                  </p>
                </div>
              ) : (
                <ul className="mt-3 space-y-3.5">
                  {alerts.slice(0, 4).map((a) => {
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
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone.pill}`}
                          >
                            {Math.round(a.percent * 100)}%
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted/70">
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
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
