import { Card, CardContent } from '@/components/ui/card';
import { formatMoney, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export function RecentTransactions({ transactions, currency }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">Recent activity</h3>
          <span className="text-xs text-muted-foreground">Last 5</span>
        </div>

        {transactions.length === 0 ? (
          <div className="flex h-28 flex-col items-center justify-center text-center">
            <p className="text-sm font-medium">Nothing logged yet</p>
            <p className="text-xs text-muted-foreground">Tap the + button to add your first transaction.</p>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {transactions.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-3">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg"
                  style={{ backgroundColor: `${t.category?.color ?? '#64748b'}22` }}
                >
                  {t.category?.icon ?? '📦'}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {t.description?.trim() || t.category?.name || 'Transaction'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t.category?.name ?? 'Uncategorised'} · {formatDate(t.date, { format: 'relative' })}
                  </p>
                </div>
                <p
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    t.type === 'income' ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {t.type === 'income' ? '+' : '−'}
                  {formatMoney(t.amount, currency)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
