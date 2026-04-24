import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatCard({ label, value, sub, icon, accent = 'primary', className }) {
  const accentClass = {
    primary: 'bg-primary/10 text-primary',
    warning: 'bg-amber-500/15 text-amber-400',
    streak: 'bg-orange-500/15 text-orange-400',
    muted: 'bg-muted text-muted-foreground',
  }[accent];

  return (
    <Card className={cn('relative overflow-hidden', className)}>
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="truncate text-2xl font-bold tracking-tight">{value}</p>
          {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
        </div>
        {icon ? (
          <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg', accentClass)}>
            {icon}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
