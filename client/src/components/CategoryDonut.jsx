import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';

export function CategoryDonut({ breakdown, totalExpenses, currency }) {
  const hasData = breakdown.length > 0 && totalExpenses > 0;

  return (
    <Card>
      <CardContent className="p-6">
        <h3 className="text-sm font-medium text-muted-foreground">Spending by category</h3>

        {!hasData ? (
          <div className="flex h-56 flex-col items-center justify-center gap-1 text-center">
            <div className="text-4xl">🌱</div>
            <p className="text-sm font-medium">No expenses yet this month</p>
            <p className="text-xs text-muted-foreground">Log a transaction and we'll chart it here.</p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-6 sm:flex-row sm:items-center">
            <div className="relative mx-auto h-44 w-44 shrink-0 sm:mx-0">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={breakdown}
                    dataKey="total"
                    nameKey="name"
                    innerRadius={56}
                    outerRadius={80}
                    stroke="none"
                    paddingAngle={2}
                  >
                    {breakdown.map((entry) => (
                      <Cell key={entry.categoryId} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Total</p>
                <p className="text-lg font-bold">{formatMoney(totalExpenses, currency)}</p>
              </div>
            </div>

            <ul className="flex-1 space-y-2">
              {breakdown.slice(0, 5).map((c) => (
                <li key={c.categoryId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: c.color }}
                    />
                    <span className="truncate">
                      <span className="mr-1">{c.icon}</span>
                      {c.name}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatMoney(c.total, currency)}
                  </span>
                </li>
              ))}
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
