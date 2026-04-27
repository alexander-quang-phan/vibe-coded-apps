import { useQuery } from '@tanstack/react-query';
import { TrendingUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';

function ProjectionShell({ children, glow }) {
  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      <div
        aria-hidden
        className={`pointer-events-none absolute -bottom-12 -right-10 h-28 w-28 rounded-full blur-2xl ${glow}`}
      />
      <CardContent className="relative p-6">{children}</CardContent>
    </Card>
  );
}

function ProjectionHeader({ daysElapsed, daysInMonth }) {
  return (
    <div className="flex items-baseline justify-between">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Month-end projection
      </h3>
      {daysElapsed && daysInMonth ? (
        <span className="nums text-xs text-muted-foreground">
          Day {daysElapsed} of {daysInMonth}
        </span>
      ) : null}
    </div>
  );
}

export function MonthProjection({ currency }) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['projections', 'month'],
    queryFn: () => api.get('/api/projections/month'),
  });

  if (isLoading) {
    return (
      <ProjectionShell glow="bg-primary/10">
        <div className="animate-pulse space-y-3">
          <div className="h-3 w-40 rounded bg-muted" />
          <div className="h-8 w-56 rounded bg-muted" />
          <div className="h-3 w-44 rounded bg-muted" />
        </div>
      </ProjectionShell>
    );
  }

  if (!data) return null;

  if (!data.ready) {
    return (
      <ProjectionShell glow="bg-primary/10">
        <ProjectionHeader daysElapsed={data.daysElapsed} daysInMonth={data.daysInMonth} />
        <div className="mt-4 flex items-center gap-3">
          <span className="text-3xl animate-float-slow" aria-hidden>
            🌱
          </span>
          <div>
            <p className="text-sm font-medium">Too early to tell</p>
            <p className="text-xs text-muted-foreground">
              Log a few days first — projections need a bit of data to lean on.
            </p>
          </div>
        </div>
      </ProjectionShell>
    );
  }

  const { projectedSpend, monthlyBudget, delta, paceLabel, daysElapsed, daysInMonth } = data;
  const isOver = delta !== null && delta < 0;

  let deltaLine;
  if (delta === null) {
    deltaLine = (
      <p className="mt-2 text-sm text-muted-foreground">
        Set a monthly budget to see how this lines up.
      </p>
    );
  } else if (isOver) {
    deltaLine = (
      <p className="mt-2 text-sm font-medium text-rose-400">
        On pace to overshoot by{' '}
        <span className="nums">{formatMoney(Math.abs(delta), currency)}</span> — want to adjust?
      </p>
    );
  } else {
    deltaLine = (
      <p className="mt-2 text-sm font-medium text-primary">
        On pace to land <span className="nums">{formatMoney(delta, currency)}</span> under budget 🌿
      </p>
    );
  }

  return (
    <ProjectionShell glow={isOver ? 'bg-rose-400/15' : 'bg-primary/15'}>
      <ProjectionHeader daysElapsed={daysElapsed} daysInMonth={daysInMonth} />

      <div className="mt-3 flex items-baseline gap-2">
        <p className="nums text-3xl font-bold tracking-tight">
          {formatMoney(projectedSpend, currency)}
        </p>
        <span className="text-xs text-muted-foreground">projected by month-end</span>
      </div>

      {deltaLine}

      <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <TrendingUp className="h-3 w-3 text-primary" />
        {paceLabel}
        {monthlyBudget !== null ? (
          <span className="ml-1 text-muted-foreground/80">
            · budget {formatMoney(monthlyBudget, currency)}
          </span>
        ) : null}
      </p>
    </ProjectionShell>
  );
}
