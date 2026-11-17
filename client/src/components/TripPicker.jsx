import { Plane } from 'lucide-react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTrips } from '@/hooks/useTrips';
import { stopForDate } from '@/lib/trips';

const NO_TRIP = 'none';
const FROM_DATE = 'auto';

/**
 * Pick a trip and, optionally, a city other than the one its date implies. Lists trips
 * that aren't archived, plus `includeTripId` even when archived, so a row's own trip can
 * always be shown. Renders nothing for someone with no trips to choose from.
 *
 * Controlled: `onTripChange` and `onStopChange` fire only from Alex's own choices, so a
 * parent reacts in those handlers and never in an effect on trip data (BUGS-FIXED shape 8).
 */
export function TripPicker({
  tripId,
  stopId,
  date,
  onTripChange,
  onStopChange,
  includeTripId = null,
  disabledReason = null,
  showStops = true,
}) {
  const { data } = useTrips();
  const trips = (data?.trips ?? []).filter((t) => !t.archivedAt || t.id === includeTripId || t.id === tripId);
  if (trips.length === 0) return null;

  const trip = trips.find((t) => t.id === tripId) ?? null;
  const stops = trip?.stops ?? [];
  const derived = stopForDate(stops, date);

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
      <div className="space-y-1.5">
        <Label className="flex items-center gap-2 text-sm font-medium">
          <Plane className="h-4 w-4 text-primary" aria-hidden />
          Trip
        </Label>
        <Select
          value={tripId ?? NO_TRIP}
          onValueChange={(v) => onTripChange(v === NO_TRIP ? null : v)}
          disabled={!!disabledReason}
        >
          <SelectTrigger aria-label="Trip">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TRIP}>No trip</SelectItem>
            {trips.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
                {t.archivedAt ? ' (archived)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
      </div>

      {showStops && trip && stops.length > 0 && !disabledReason ? (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">City</Label>
          <Select
            value={stopId && stopId !== derived?.id ? stopId : FROM_DATE}
            onValueChange={(v) => onStopChange(v === FROM_DATE ? null : v)}
          >
            <SelectTrigger aria-label="City">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FROM_DATE}>
                {derived ? `${derived.name} (from the date)` : 'No city (outside its stops)'}
              </SelectItem>
              {stops.filter((s) => s.id !== derived?.id).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}
