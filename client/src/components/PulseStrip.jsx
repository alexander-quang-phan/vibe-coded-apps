import { Flame, Shield, Trophy, Wallet } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/*
 * The "pulse strip" — one instrument cluster instead of a grid of identical
 * stat cards (that uniform cadence was the single biggest generic-AI tell on
 * the Dashboard). Four segments behind one hairline frame:
 *
 *   [ STREAK (focal, warm) | shields | logged | LEVEL + XP bar ]
 *
 * The streak is Trim's emotional core, so it gets the scale and the warmth;
 * shields/logged read as supporting gauges; level anchors the right edge with
 * the gold-tipped XP bar. 2×2 on mobile, one row on lg.
 */
export function PulseStrip({ stats, transactionCount }) {
  const pct = Math.max(0, Math.min(100, (stats.xpIntoLevel / stats.xpForNextLevel) * 100));
  const close = pct >= 80;

  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      {/* Warm bleed behind the streak corner, gold bleed behind the level corner */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-10 -top-12 h-36 w-36 rounded-full bg-orange-500/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-14 -right-10 h-40 w-40 rounded-full blur-3xl"
        style={{
          background: 'radial-gradient(closest-side, hsl(var(--gold) / 0.28), transparent)',
          opacity: 0.4 + pct / 200,
        }}
      />

      <CardContent className="relative grid grid-cols-2 p-0 lg:grid-cols-[1.35fr_1fr_1fr_1.7fr]">
        {/* Streak — the focal segment */}
        <div className="flex items-center gap-3 p-5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/20">
            <Flame className="h-6 w-6 animate-flame" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Streak
            </p>
            <p className="nums text-3xl font-extrabold leading-none tracking-tight sm:text-4xl">
              {stats.currentStreak}
              <span className="ml-1 text-sm font-semibold text-muted-foreground">
                {stats.currentStreak === 1 ? 'day' : 'days'}
              </span>
            </p>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {stats.shields > 0
                ? `${stats.shields} shield${stats.shields > 1 ? 's' : ''} banked`
                : `Longest: ${stats.longestStreak}`}
            </p>
          </div>
        </div>

        {/* Shields */}
        <Gauge
          className="border-l border-border/60"
          icon={<Shield className="h-4 w-4" />}
          iconTone="bg-sky-500/15 text-sky-400 ring-sky-500/20"
          label="Shields"
          value={stats.shields}
          sub="1 per 7-day run"
        />

        {/* Logged this month */}
        <Gauge
          className="border-t border-border/60 lg:border-l lg:border-t-0"
          icon={<Wallet className="h-4 w-4" />}
          iconTone="bg-muted text-muted-foreground ring-border"
          label="Logged"
          value={transactionCount}
          sub="this month"
        />

        {/* Level + XP */}
        <div className="flex flex-col justify-center gap-2 border-l border-t border-border/60 p-5 lg:border-t-0">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Level {stats.level} ·{' '}
              <span className="normal-case text-xs font-bold tracking-normal text-foreground">
                {stats.title}
              </span>
            </p>
            <Trophy className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-muted/80">
            <div
              className="shimmer-bar h-full rounded-full transition-all duration-700"
              style={{
                width: `${pct}%`,
                background:
                  'linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.85) 60%, hsl(var(--gold) / 0.95) 100%)',
              }}
            />
          </div>
          <p className="flex items-center justify-between text-[11px]">
            <span className="nums text-muted-foreground">
              {stats.xpIntoLevel}/{stats.xpForNextLevel} XP
            </span>
            <span className={close ? 'font-medium text-amber-400' : 'text-muted-foreground'}>
              {close ? '✨ Almost there' : `${stats.xpForNextLevel - stats.xpIntoLevel} to go`}
            </span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Gauge({ icon, iconTone, label, value, sub, className }) {
  return (
    <div className={cn('flex items-center gap-2.5 p-5', className)}>
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1',
          iconTone,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </p>
        <p className="nums text-xl font-bold leading-tight tracking-tight">{value}</p>
        <p className="text-[11px] leading-snug text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}
