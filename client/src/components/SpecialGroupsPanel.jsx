import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, Star } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useApi } from '@/hooks/useApi';
import { formatMoney, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Phase 10 (B1) — "Special expenses" panel on the Dashboard.
 *
 * Each group shows its LIFETIME total, because the case this exists for is a
 * trip paid across several months ("September 2026 Paris holiday"). A total
 * that reset on the 1st would answer the wrong question.
 *
 * The "Ungrouped" row is what makes the panel trustworthy: grouping is
 * optional, so without it the rows would quietly fail to add up to the month's
 * special spend and the user would have no way to tell.
 */
export function SpecialGroupsPanel({ currency, specialThisMonth = 0 }) {
  const api = useApi();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['special-groups'],
    queryFn: () => api.get('/api/special-groups'),
  });
  const groups = data?.groups ?? [];

  // Nothing to show and nothing to explain — stay out of the way entirely.
  if (groups.length === 0 && specialThisMonth === 0) return null;

  const groupedTotal = groups.reduce((sum, g) => sum + g.total, 0);
  const active = groups.filter((g) => !g.archivedAt);
  const archived = groups.filter((g) => g.archivedAt);

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="p-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <Star className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            Special expenses
          </span>
          <span className="flex items-center gap-2">
            <span className="nums text-sm font-semibold text-amber-400">
              {formatMoney(groupedTotal, currency)}
            </span>
            <ChevronDown
              className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')}
              aria-hidden
            />
          </span>
        </button>

        {open ? (
          <div className="mt-3 space-y-1 border-t border-border/60 pt-3">
            {active.length === 0 && archived.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No groups yet — tick "Special expense" when logging one and you can file it under a
                trip or occasion.
              </p>
            ) : null}

            {[...active, ...archived].map((g) => (
              <Link
                key={g.id}
                to={`/transactions?specialGroup=${g.id}`}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/50"
              >
                <span className="min-w-0">
                  <span className={cn('block truncate text-sm', g.archivedAt && 'text-muted-foreground line-through')}>
                    {g.name}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {g.count === 1 ? '1 expense' : `${g.count} expenses`}
                    {g.firstDate ? ` · from ${formatDate(g.firstDate)}` : ''}
                  </span>
                </span>
                <span className="nums shrink-0 text-sm font-medium">
                  {formatMoney(g.total, currency)}
                </span>
              </Link>
            ))}

            {/* Keeps the panel honest — grouping is optional, so this is what
                the group rows don't cover this month. */}
            {specialThisMonth > 0 ? (
              <p className="border-t border-border/60 px-2 pt-2 text-[11px] text-muted-foreground">
                <span className="nums font-medium text-foreground">
                  {formatMoney(specialThisMonth, currency)}
                </span>{' '}
                of special spend this month
                {groupedTotal > 0 ? ' · group totals above are lifetime, not monthly' : ''}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
