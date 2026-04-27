import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';

export function CategoryDonut({ breakdown, totalExpenses, currency }) {
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
            Spending by category
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
          <div className="mt-5 flex flex-col gap-6 sm:flex-row sm:items-center">
            <div className="relative mx-auto h-48 w-48 shrink-0 sm:mx-0">
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

            <ul className="flex-1 space-y-2.5">
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
