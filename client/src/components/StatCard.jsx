import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/*
 * Each accent has a soft inner orb (icon backdrop) plus a barely-there outer
 * glow that bleeds out of the bottom-right corner. The corner glow + hover
 * lift give the card depth without dropping a heavy drop shadow on it.
 */
const ACCENTS = {
  primary: {
    orb: 'bg-primary/15 text-primary',
    bleed: 'bg-primary/15',
    ring: 'ring-primary/20',
  },
  warning: {
    orb: 'bg-amber-500/15 text-amber-400',
    bleed: 'bg-amber-500/12',
    ring: 'ring-amber-500/20',
  },
  streak: {
    orb: 'bg-orange-500/15 text-orange-400',
    bleed: 'bg-orange-500/15',
    ring: 'ring-orange-500/20',
  },
  info: {
    orb: 'bg-sky-500/15 text-sky-400',
    bleed: 'bg-sky-500/12',
    ring: 'ring-sky-500/20',
  },
  muted: {
    orb: 'bg-muted text-muted-foreground',
    bleed: 'bg-foreground/5',
    ring: 'ring-border',
  },
};

export function StatCard({ label, value, sub, icon, accent = 'primary', className }) {
  const a = ACCENTS[accent] ?? ACCENTS.primary;

  return (
    <Card
      className={cn(
        'lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur',
        className,
      )}
    >
      {/* Corner bleed: a soft blurred halo so the card has weight */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -bottom-12 -right-10 h-28 w-28 rounded-full blur-2xl',
          a.bleed,
        )}
      />

      <CardContent className="relative flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {label}
          </p>
          <p className="nums truncate text-2xl font-bold tracking-tight">{value}</p>
          {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
        </div>
        {icon ? (
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg ring-1',
              a.orb,
              a.ring,
            )}
          >
            {icon}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
