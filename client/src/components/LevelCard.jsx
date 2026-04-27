import { Card, CardContent } from '@/components/ui/card';
import { Trophy } from 'lucide-react';

export function LevelCard({ level, title, xpIntoLevel, xpForNextLevel }) {
  const pct = Math.max(0, Math.min(100, (xpIntoLevel / xpForNextLevel) * 100));
  const close = pct >= 80;
  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      {/* Subtle gold glow that gets brighter as you near the next level */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full blur-3xl transition-opacity"
        style={{
          background: 'radial-gradient(closest-side, hsl(var(--gold) / 0.30), transparent)',
          opacity: 0.4 + pct / 200,
        }}
      />

      <CardContent className="relative space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Level {level}
            </p>
            <p className="truncate text-base font-bold tracking-tight">{title}</p>
          </div>
          <div className="relative shrink-0">
            <span
              aria-hidden
              className="absolute inset-0 rounded-full bg-gradient-to-br from-amber-300/30 to-primary/20 blur-md"
            />
            <div className="relative flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-amber-200/20 to-primary/15 text-primary ring-1 ring-primary/30">
              <Trophy className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div>
          <div className="relative h-2.5 overflow-hidden rounded-full bg-muted/80">
            <div
              className="shimmer-bar h-full rounded-full transition-all duration-700"
              style={{
                width: `${pct}%`,
                background:
                  'linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.85) 60%, hsl(var(--gold) / 0.95) 100%)',
              }}
            />
          </div>
          <p className="mt-1.5 flex items-center justify-between text-xs">
            <span className="nums text-muted-foreground">
              {xpIntoLevel} / {xpForNextLevel} XP
            </span>
            <span className={close ? 'font-medium text-amber-400' : 'text-muted-foreground'}>
              {close ? '✨ Almost there' : `${xpForNextLevel - xpIntoLevel} XP to next level`}
            </span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
