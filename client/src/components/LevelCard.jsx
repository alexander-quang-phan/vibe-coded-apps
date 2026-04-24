import { Card, CardContent } from '@/components/ui/card';
import { Trophy } from 'lucide-react';

export function LevelCard({ level, title, xpIntoLevel, xpForNextLevel }) {
  const pct = Math.max(0, Math.min(100, (xpIntoLevel / xpForNextLevel) * 100));
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Level {level}</p>
            <p className="truncate text-base font-semibold tracking-tight">{title}</p>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Trophy className="h-5 w-5" />
          </div>
        </div>
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {xpIntoLevel} / {xpForNextLevel} XP to next level
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
