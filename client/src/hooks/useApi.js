import { useMemo } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

/**
 * Returns a fetcher pre-bound to the current session token. Re-memoised when
 * the session changes so TanStack Query automatically picks up the new JWT.
 */
export function useApi() {
  const { session } = useAuth();
  const token = session?.access_token;

  return useMemo(
    () => ({
      get: (path, opts) => apiFetch(path, { ...opts, method: 'GET', token }),
      post: (path, body, opts) => apiFetch(path, { ...opts, method: 'POST', body, token }),
      patch: (path, body, opts) => apiFetch(path, { ...opts, method: 'PATCH', body, token }),
      del: (path, opts) => apiFetch(path, { ...opts, method: 'DELETE', token }),
    }),
    [token],
  );
}
