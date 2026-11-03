import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/hooks/useApi';

/**
 * Every trip with its headline figures. Feeds the Trips page, the Dashboard card, the
 * pickers and Quick Add's tag, so they share one fetch. App.jsx calls this at start, so
 * the tag is ready the first time Quick Add opens abroad.
 */
export function useTrips() {
  const api = useApi();
  return useQuery({
    queryKey: ['trips'],
    queryFn: () => api.get('/api/trips'),
    staleTime: 60_000,
    retry: 1,
  });
}
