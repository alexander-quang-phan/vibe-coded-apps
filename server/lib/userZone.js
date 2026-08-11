import { supabase } from './supabase.js';
import { DEFAULT_TIMEZONE } from './month.js';

/**
 * The user's IANA timezone, or UTC when they have not reported one.
 *
 * Deliberately its own tiny query rather than being read out of the `user_stats`
 * row each route already fetches: those fetches sit inside the same Promise.all
 * as the transactions query, which needs the month bounds to be built *first*.
 * One extra primary-key lookup is a fair price for every route resolving the
 * period the same way, and lib/month.js stays pure and unit-testable because it
 * never touches the database.
 */
export async function userTimeZone(userId) {
  const { data, error } = await supabase
    .from('user_stats')
    .select('timezone')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.timezone || DEFAULT_TIMEZONE;
}
