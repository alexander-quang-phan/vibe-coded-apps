import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { tripLabel } from '@/lib/trips';
import { cn } from '@/lib/utils';

/**
 * Quick Add's visible tag: nothing it seeds is invisible. ✕ logs this one as a normal
 * expense; tapping the tag opens a chooser for another city or "Not part of this trip".
 */
export function TripTag({ tag, onChoose }) {
  const [choosing, setChoosing] = useState(false);
  const { trip, stop } = tag;
  const stops = trip.stops ?? [];

  return (
    <div className="space-y-1.5">
      <div className="inline-flex max-w-full items-center rounded-full border border-sky-400/40 bg-sky-400/10 text-xs font-medium text-sky-700 dark:text-sky-300">
        <button
          type="button"
          onClick={() => setChoosing((v) => !v)}
          aria-expanded={choosing}
          aria-label={`${tripLabel(trip.name, stop?.name)}, change`}
          className="truncate rounded-l-full py-1 pl-3 pr-1.5 hover:underline"
        >
          {tripLabel(trip.name, stop?.name)}
        </button>
        <button
          type="button"
          onClick={() => {
            setChoosing(false);
            onChoose({ none: true });
          }}
          aria-label="Not part of this trip"
          className="rounded-r-full py-1 pl-1 pr-2 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {choosing ? (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-border/60 bg-secondary/30 p-2">
          {stops.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setChoosing(false);
                onChoose({ tripId: trip.id, stopId: s.id });
              }}
              aria-pressed={s.id === stop?.id}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                s.id === stop?.id
                  ? 'border-primary/60 bg-primary/15 text-primary'
                  : 'border-border/70 bg-secondary/40 text-muted-foreground hover:text-foreground',
              )}
            >
              {s.id === stop?.id ? <Check className="h-3 w-3" aria-hidden /> : null}
              {s.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setChoosing(false);
              onChoose({ none: true });
            }}
            className="rounded-full border border-dashed border-border/70 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Not part of this trip
          </button>
        </div>
      ) : null}
    </div>
  );
}
