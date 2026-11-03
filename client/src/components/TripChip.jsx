import { Link } from 'react-router-dom';
import { cityOf, tripLabel } from '@/lib/trips';

/** "✈️ Italy · Rome" on a transaction row, with 📍 when Alex chose the city by hand. */
export function TripChip({ tx, tripsById }) {
  const trip = tripsById.get(tx.trip_id);
  if (!trip) return null;
  const stop = cityOf(tx, trip.stops);
  const pinned = !!tx.trip_stop_id && stop?.id === tx.trip_stop_id;
  return (
    <Link
      to={`/trips/${trip.id}`}
      title={pinned ? 'City set by you' : undefined}
      className="inline-block max-w-[11rem] shrink-0 truncate rounded-full border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 hover:underline dark:text-sky-300"
    >
      {tripLabel(trip.name, stop?.name)}
      {pinned ? ' 📍' : ''}
    </Link>
  );
}
