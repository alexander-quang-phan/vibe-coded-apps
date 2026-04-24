const BASE_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * Thin fetch wrapper for our Express API. Attach the Supabase JWT via `token`
 * to hit protected routes. Returns parsed JSON or throws on !ok.
 */
export async function apiFetch(path, { method = 'GET', body, token, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const err = new Error(payload.error || `Request failed with status ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res.status === 204 ? null : res.json();
}
