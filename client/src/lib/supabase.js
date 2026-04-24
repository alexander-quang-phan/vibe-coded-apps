import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !ANON_KEY) {
  // Surface a clear error during development rather than failing deep inside SDK calls.
  // eslint-disable-next-line no-console
  console.warn('[trim] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set');
}

// Browser client — uses the public anon key only to sign up / log in.
// All data access is mediated through our Express API.
export const supabase = createClient(URL ?? 'http://placeholder.invalid', ANON_KEY ?? 'placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
