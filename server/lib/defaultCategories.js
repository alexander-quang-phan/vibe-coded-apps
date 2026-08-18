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
import { encryptRegistered, blindIndex } from './crypto.js';
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
 * Fill in `name_enc`/`name_hmac` for any category that has a plaintext name but
 * no ciphertext yet.
 *
 * ONLY meaningful in the `dual` phase: in `off` the `_enc` columns may not exist,
 * and in `enc` the plaintext is gone so there is nothing left to derive them from
 * (nor anything to repair — by then the trigger has long stopped seeding).
 *
 * Its job is the window between "migration 001's trigger last seeded somebody"
 * and "migration 018a replaced it". Any account created in that window has twelve
 * plaintext-only category names, which the gate correctly refuses to certify.
 */
async function repairMissingCiphertext(supabase, userId) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name')
    .eq('user_id', userId)
    .is('name_enc', null);
  if (error) throw error;
  if (!data || data.length === 0) return 0;

  let repaired = 0;
  for (const row of data) {
    if (row.name === null || row.name === undefined) continue; // nothing to derive from
    const { error: updateErr } = await supabase
      .from('categories')
      .update({
        name_enc: encryptRegistered('categories.name', userId, row.name),
        name_hmac: blindIndex('categories.name_hmac', userId, row.name),
      })
      .eq('id', row.id);
    if (updateErr) throw updateErr;
    repaired += 1;
  }
  return repaired;
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

  const { data, error } = await supabase
    .from('categories')
    .select('id')
    .eq('user_id', userId)
    .limit(1);
  if (error) throw error;

  if (data && data.length > 0) {
    // Present, but not necessarily dual-written. See repairMissingCiphertext.
    if (phase === 'dual') {
      const repaired = await repairMissingCiphertext(supabase, userId);
      if (repaired > 0) return { seeded: 0, repaired, reason: 'repaired' };
    }
    return { seeded: 0, repaired: 0, reason: 'already-present' };
  }

  const rows = DEFAULT_CATEGORIES.map((d) => defaultCategoryRow(userId, d, phase));
  const { error: insertErr } = await supabase.from('categories').insert(rows);
  if (insertErr) {
    // 23505 = unique_violation: another request seeded them a moment ago.
    if (insertErr.code === '23505') return { seeded: 0, repaired: 0, reason: 'raced' };
    throw insertErr;
  }
  return { seeded: rows.length, repaired: 0, reason: 'seeded' };
}
