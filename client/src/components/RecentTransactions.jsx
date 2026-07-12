import { Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatMoney, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export function RecentTransactions({ transactions, currency, onDelete, pendingDeleteId }) {
  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Recent activity
          </h3>
          <span className="text-xs text-muted-foreground">Last 5</span>
        </div>

        {transactions.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-center">
            <span className="text-3xl animate-float-slow" aria-hidden>
              ✨
            </span>
            <p className="mt-1 text-sm font-medium">Nothing logged yet</p>
            <p className="text-xs text-muted-foreground">
              Tap the + button to add your first transaction.
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-1">
            {transactions.map((t) => {
              const color = t.category?.color ?? '#64748b';
              const pending = pendingDeleteId === t.id;
              return (
                <li
                  key={t.id}
                  className={cn(
                    'group relative flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-accent/50',
                    pending && 'opacity-50',
                  )}
                >
                  {/* Left edge accent strip on hover */}
                  <span
                    aria-hidden
                    className="absolute inset-y-2 left-0 w-0.5 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                    style={{ backgroundColor: color }}
                  />
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg ring-1 ring-border/60"
                    style={{ backgroundColor: `${color}22` }}
                  >
                    {t.category?.icon ?? '📦'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {t.description?.trim() || t.category?.name || 'Transaction'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {/* Skip the category when it's already the title (no-note quick-adds) */}
                      {t.description?.trim() ? `${t.category?.name ?? 'Uncategorised'} · ` : ''}
                      {formatDate(t.date, { format: 'relative' })}
                    </p>
                  </div>
                  <p
                    className={cn(
                      'nums shrink-0 text-sm font-semibold',
                      t.type === 'income' ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {t.type === 'income' ? '+' : '−'}
                    {formatMoney(t.amount, currency)}
                  </p>
                  {onDelete ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground opacity-60 transition-opacity hover:text-foreground group-hover:opacity-100 sm:opacity-0"
                      onClick={() => {
                        if (confirm('Delete this transaction?')) onDelete(t);
                      }}
                      disabled={pending}
                      aria-label="Delete transaction"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
