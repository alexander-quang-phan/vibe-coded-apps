/**
 * The 12 default categories every new user starts with — and the code that seeds
 * them, which until now lived in the database.
 *
 * WHY THIS MOVED  [Codex stage-4 RE-VERIFY finding 5, 2026-08-18]
 * ---------------------------------------------------------------------------
 * `public.handle_new_user()` (migration 001, lines 158-192) is an AFTER INSERT
 * trigger on auth.users that inserts these twelve rows with a literal
 * `insert into public.categories (..., name, ...)`. Migration 019 drops
 * `categories.name`. The trigger was never replaced, so after 019 either the drop
 * fails on the dependency or — worse, and what actually happens — the drop
 * succeeds and the NEXT SIGNUP errors inside the trigger, which rolls back the
 * auth.users insert. Nobody could create an account again.
 *
 * The trigger is replaced in **migration 018a**, not 019 — at the START of the
 * dual-write window rather than at the drop, so no account created during that
 * window is seeded with plaintext-only names. 019 keeps an identical replacement
 * as a safety net if 018a were ever skipped.
 * [Codex stage-5 RE-VERIFY #2 finding 4, 2026-08-18]
 *
 * The encryption spec and BUILD_PLAN.md both said this seeding had to move to the
 * API before the drop, because the database has no encryption key and therefore
 * cannot write `name_enc`. It had not been built. This is it.
 *
 * Seeding happens on `GET /api/me` AND `GET /api/categories`, and it is
 * IDEMPOTENT. Both, because the client starts those two requests independently
 * and renders as soon as they resolve: if only `/api/me` seeded, `/api/categories`
 * could return and cache an empty list for a brand-new account before the seeding
 * had finished. Whichever arrives first does the work.
 * [Codex stage-5 RE-VERIFY #2 finding 6, 2026-08-18]
 *
 * It also REPAIRS. During the `dual` window the migration-001 trigger may still
 * have seeded plaintext-only names (any account created before migration 018a is
 * applied), and "already has categories, so do nothing" would leave them without
 * `name_enc`/`name_hmac` forever — silently falsifying the dual-write invariant
 * the whole cutover rests on, and blocking the gate.
 * [Codex stage-5 RE-VERIFY #2 finding 4, 2026-08-18]
 */
import { encryptRegistered, decryptRegistered, blindIndex } from './crypto.js';
import { CURRENT_PHASE, writesPlaintext, writesCiphertext } from './encryptionPhase.js';

/**
 * Must stay identical to the list in migration 001's handle_new_user(), which is
 * still the seeder until 019 runs. test/defaultCategories.test.js parses the
 * migration and fails the build if they drift.
 */
export const DEFAULT_CATEGORIES = Object.freeze([
  { name: 'Food', icon: '🍔', color: '#f97316', type: 'expense', sort_order: 1 },
  { name: 'Transport', icon: '🚗', color: '#3b82f6', type: 'expense', sort_order: 2 },
  { name: 'Rent', icon: '🏠', color: '#8b5cf6', type: 'expense', sort_order: 3 },
  { name: 'Bills', icon: '💡', color: '#ec4899', type: 'expense', sort_order: 4 },
  { name: 'Groceries', icon: '🛒', color: '#84cc16', type: 'expense', sort_order: 5 },
  { name: 'Entertainment', icon: '🎬', color: '#f59e0b', type: 'expense', sort_order: 6 },
  { name: 'Shopping', icon: '🛍️', color: '#06b6d4', type: 'expense', sort_order: 7 },
  { name: 'Health', icon: '💊', color: '#10b981', type: 'expense', sort_order: 8 },
  { name: 'Other', icon: '📦', color: '#64748b', type: 'expense', sort_order: 9 },
  { name: 'Salary', icon: '💼', color: '#22c55e', type: 'income', sort_order: 10 },
  { name: 'Freelance', icon: '💻', color: '#14b8a6', type: 'income', sort_order: 11 },
  { name: 'Other Income', icon: '💰', color: '#eab308', type: 'income', sort_order: 12 },
]);

/**
 * One row, shaped for the phase the deployment is in.
 *
 * `off`  -> name only (today's schema)
 * `dual` -> name AND name_enc/name_hmac (012+018 applied, 019 not yet)
 * `enc`  -> name_enc/name_hmac only (019 applied; `name` no longer exists)
 */
export function defaultCategoryRow(userId, def, phase = CURRENT_PHASE) {
  const row = {
    user_id: userId,
    icon: def.icon,
    color: def.color,
    type: def.type,
    is_default: true,
    sort_order: def.sort_order,
  };
  if (writesPlaintext(phase)) row.name = def.name;
  if (writesCiphertext(phase)) {
    row.name_enc = encryptRegistered('categories.name', userId, def.name);
    // The exact-equality lookup routes/categories.js does with `.eq('name', …)`.
    row.name_hmac = blindIndex('categories.name_hmac', userId, def.name);
  }
  return row;
}

/**
 * Bring every one of a user's categories into a correct dual-written state.
 *
 * ONLY meaningful in the `dual` phase: in `off` the `_enc` columns may not exist,
 * and in `enc` the plaintext is gone so there is nothing left to derive them from
 * (nor anything to repair — by then the trigger has long stopped seeding).
 *
 * Its job is the window between "migration 001's trigger last seeded somebody"
 * and "migration 018a replaced it". Any account created in that window has twelve
 * plaintext-only category names, which the gate correctly refuses to certify.
 *
 * SELF-HEALING, and CONDITIONAL ON WHAT IT READ  [Codex stage-5 RE-VERIFY #3
 * finding 3, 2026-08-18]. The first version selected `name_enc IS NULL` and then
 * updated by `id` alone. Between those two statements a rename can land — writing
 * a new `name` AND its matching cipher and hash — and the blind update would then
 * stamp the OLD plaintext's cipher over the new one. Worse, nothing could heal it:
 * `name_enc` is no longer NULL, so neither this function nor the backfill would
 * look at that row again, and only the gate would ever notice.
 *
 * So it now (a) judges every category rather than only the NULL ones, catching a
 * cipher or hash that has gone stale for any reason, and (b) scopes each UPDATE by
 * the exact plaintext it read, so a concurrent rename makes the update match zero
 * rows instead of clobbering. Anything skipped that way is simply repaired on the
 * next request.
 */
function categoryNeedsRepair(userId, row) {
  if (row.name === null || row.name === undefined) return false; // nothing to derive from
  if (!row.name_enc || !row.name_hmac) return true;
  if (row.name_hmac !== blindIndex('categories.name_hmac', userId, row.name)) return true;
  try {
    return decryptRegistered('categories.name', userId, row.name_enc) !== row.name;
  } catch {
    return true; // unreadable cipher is a state to repair, not to trust
  }
}

async function repairMissingCiphertext(supabase, userId) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, name_enc, name_hmac')
    .eq('user_id', userId);
  if (error) throw error;
  if (!data || data.length === 0) return { repaired: 0, skipped: 0 };

  let repaired = 0;
  let skipped = 0;
  for (const row of data) {
    if (!categoryNeedsRepair(userId, row)) continue;

    const { data: touched, error: updateErr } = await supabase
      .from('categories')
      .update({
        name_enc: encryptRegistered('categories.name', userId, row.name),
        name_hmac: blindIndex('categories.name_hmac', userId, row.name),
      })
      .eq('id', row.id)
      .eq('user_id', userId)
      // THE GUARD: only write if the plaintext is still the one we encrypted.
      .eq('name', row.name)
      .select('id');
    if (updateErr) throw updateErr;

    if (touched && touched.length > 0) repaired += 1;
    else skipped += 1; // renamed underneath us; next request will catch it up
  }
  return { repaired, skipped };
}

/**
 * Give a user their default categories if they have none, and — during the dual
 * window — repair any that the database trigger seeded without ciphertext.
 *
 * Safe to call on every request; it costs one indexed `limit 1` for anybody who
 * already has them, plus one filtered read while `phase === 'dual'`.
 *
 * The race — two tabs loading a brand-new account at once — is closed in the
 * database by the partial unique index on (user_id, sort_order) where is_default,
 * added in migration 018. The loser gets a 23505 and treats it as "already
 * seeded", which is the truth. Without that index this would silently produce 24
 * categories, which is exactly the atomicity the trigger used to provide for free.
 */
export async function ensureDefaultCategories(supabase, userId, { phase = CURRENT_PHASE } = {}) {
  if (!userId) throw new Error('ensureDefaultCategories called without a userId');

  // Look for DEFAULT categories, not just any category. Probing for "any row"
  // meant a user who created one custom category before their first GET — an API
  // client, or any ordering the browser happens to produce — was treated as
  // already seeded and never got the twelve defaults at all.
  // `Other` and `Other Income` are protected from deletion by routes/categories.js,
  // so once seeded this probe keeps finding them and nothing is ever resurrected.
  // [Codex stage-5 RE-VERIFY #3 finding 3, 2026-08-18]
  const { data, error } = await supabase
    .from('categories')
    .select('id')
    .eq('user_id', userId)
    .eq('is_default', true)
    .limit(1);
  if (error) throw error;

  if (data && data.length > 0) {
    // Present, but not necessarily dual-written. See repairMissingCiphertext.
    if (phase === 'dual') {
      const { repaired, skipped } = await repairMissingCiphertext(supabase, userId);
      if (repaired > 0 || skipped > 0) return { seeded: 0, repaired, skipped, reason: 'repaired' };
    }
    return { seeded: 0, repaired: 0, skipped: 0, reason: 'already-present' };
  }

  const rows = DEFAULT_CATEGORIES.map((d) => defaultCategoryRow(userId, d, phase));
  const { error: insertErr } = await supabase.from('categories').insert(rows);
  if (insertErr) {
    // 23505 = unique_violation: another request seeded them a moment ago.
    if (insertErr.code === '23505') return { seeded: 0, repaired: 0, skipped: 0, reason: 'raced' };
    throw insertErr;
  }
  return { seeded: rows.length, repaired: 0, skipped: 0, reason: 'seeded' };
}
