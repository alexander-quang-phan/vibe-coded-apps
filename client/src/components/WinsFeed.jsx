import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useApi } from '@/hooks/useApi';

function formatWinDate(value) {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const compare = new Date(date);
  compare.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - compare) / 86_400_000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function WinsFeed() {
  const api = useApi();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['wins'],
    queryFn: () => api.get('/api/wins'),
  });

  const wins = data?.wins ?? [];

  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="p-6">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Wins feed
          </h3>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Latest 10
          </span>
        </div>

        {isLoading ? (
          <div className="mt-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex animate-pulse items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-muted" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3 w-3/4 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="flex h-32 flex-col items-center justify-center text-center">
            <span className="text-3xl animate-float-slow" aria-hidden>
              ✨
            </span>
            <p className="mt-1 text-sm font-medium">Wins are warming up</p>
            <p className="text-xs text-muted-foreground">
              Your dashboard still works. We just could not load this feed.
            </p>
          </div>
        ) : wins.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-center">
            <span className="text-3xl animate-float-slow" aria-hidden>
              🌱
            </span>
            <p className="mt-1 text-sm font-medium">No wins yet</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Log a transaction, add to a goal, or set a budget. Trim will spot the good stuff.
            </p>
          </div>
        ) : (
          <ul className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1">
            {wins.map((win, index) => (
              <li
                key={`${win.type}-${win.at}-${index}`}
                className="group flex items-start gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-accent/50"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg ring-1 ring-primary/15">
                  {win.icon ?? '✨'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium leading-snug">{win.title}</p>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatWinDate(win.at)}
                    </span>
                  </div>
                  {win.body ? (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {win.body}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
