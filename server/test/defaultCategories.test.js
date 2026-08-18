/**
 * The default-category seeding that migration 019 forces out of the database.
 *
 * Codex's stage-4 RE-VERIFY finding 5: migration 019 drops `categories.name`
 * while `public.handle_new_user()` — an AFTER INSERT trigger on auth.users — is
 * still doing `insert into public.categories (..., name, ...)`. After the drop the
 * next signup raises inside that trigger, which rolls back the auth.users insert,
 * so account creation breaks completely. The spec always said this seeding had to
 * move to the API (the database has no encryption key and cannot write name_enc);
 * it had never been built.
 *
 * These tests cover the replacement AND the migration ordering that makes it safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const {
  DEFAULT_CATEGORIES, defaultCategoryRow, ensureDefaultCategories,
} = await import('../lib/defaultCategories.js');
const { encryptionPhase, writesPlaintext, writesCiphertext, PHASES } = await import('../lib/encryptionPhase.js');
const { decryptRegistered, blindIndex } = await import('../lib/crypto.js');

const U = '00000000-0000-4000-8000-000000000001';
const sqlOf = (f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
const M001 = sqlOf('001_init.sql');
const M018 = sqlOf('018_encryption_text_columns.sql');
const M019 = sqlOf('019_encryption_drop_plaintext.sql');

/**
 * Minimal PostgREST double: `.select().eq().limit()` for the existence probe and
 * `.insert()` for the seeding.
 */
function fakeDb({ existing = [], insertError = null } = {}) {
  const inserted = [];
  return {
    inserted,
    from() {
      const q = {
        select() { return q; },
        eq() { return q; },
        limit() { return Promise.resolve({ data: existing, error: null }); },
        insert(rows) {
          if (insertError) return Promise.resolve({ error: insertError });
          inserted.push(...rows);
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
}

// --- the list itself ---------------------------------------------------------

test('the seeded list matches migration 001 exactly, name for name', () => {
  // While the trigger is still installed it is the seeder, so a drift here would
  // mean new users and repaired users get different categories.
  const fromSql = [...M001.matchAll(
    /\(new\.id,\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'(income|expense)',\s*true,\s*(\d+)\)/g,
  )].map((m) => ({ name: m[1], icon: m[2], color: m[3], type: m[4], sort_order: Number(m[5]) }));

  assert.equal(fromSql.length, 12, 'migration 001 should seed twelve categories');
  assert.deepEqual(DEFAULT_CATEGORIES.map((c) => ({ ...c })), fromSql);
});

// --- phase-aware row shape ---------------------------------------------------

test('phase off writes plaintext only — identical to today', () => {
  const row = defaultCategoryRow(U, DEFAULT_CATEGORIES[0], 'off');
  assert.equal(row.name, 'Food');
  assert.equal(row.name_enc, undefined);
  assert.equal(row.name_hmac, undefined);
  assert.equal(row.is_default, true);
  assert.equal(row.sort_order, 1);
});

test('phase dual writes BOTH, so the backfill stays true during the window', () => {
  const row = defaultCategoryRow(U, DEFAULT_CATEGORIES[0], 'dual');
  assert.equal(row.name, 'Food');
  assert.equal(decryptRegistered('categories.name', U, row.name_enc), 'Food');
  assert.equal(row.name_hmac, blindIndex('categories.name_hmac', U, 'Food'));
});

test('phase enc writes NO plaintext — the column no longer exists', () => {
  const row = defaultCategoryRow(U, DEFAULT_CATEGORIES[0], 'enc');
  assert.ok(!('name' in row), 'writing `name` after 019 would error on every signup');
  assert.equal(decryptRegistered('categories.name', U, row.name_enc), 'Food');
  assert.equal(row.name_hmac, blindIndex('categories.name_hmac', U, 'Food'));
});

test('the blind index is per-user, so two users hash the same name differently', () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const a = defaultCategoryRow(U, DEFAULT_CATEGORIES[4], 'enc');
  const b = defaultCategoryRow(other, DEFAULT_CATEGORIES[4], 'enc');
  assert.notEqual(a.name_hmac, b.name_hmac);
});

// --- idempotence -------------------------------------------------------------

test('seeds twelve categories for a user who has none', async () => {
  const db = fakeDb({ existing: [] });
  const r = await ensureDefaultCategories(db, U, { phase: 'off' });
  assert.equal(r.seeded, 12);
  assert.equal(db.inserted.length, 12);
  assert.deepEqual(db.inserted.map((c) => c.name), DEFAULT_CATEGORIES.map((c) => c.name));
  assert.ok(db.inserted.every((c) => c.user_id === U && c.is_default === true));
});

test('does nothing for a user who already has categories', async () => {
  // This is what makes it safe to ship BEFORE 019: the trigger has already run,
  // so for every existing user and every new signup today this is a no-op.
  const db = fakeDb({ existing: [{ id: 'c1' }] });
  const r = await ensureDefaultCategories(db, U, { phase: 'off' });
  assert.equal(r.seeded, 0);
  assert.equal(r.reason, 'already-present');
  assert.equal(db.inserted.length, 0);
});

test('a lost race is treated as already seeded, not as an error', async () => {
  // Two tabs opening a brand-new account. The partial unique index added in
  // migration 018 rejects the loser with 23505; that is success, not failure.
  const db = fakeDb({ existing: [], insertError: { code: '23505', message: 'duplicate key' } });
  const r = await ensureDefaultCategories(db, U, { phase: 'off' });
  assert.equal(r.seeded, 0);
  assert.equal(r.reason, 'raced');
});

test('any other insert error is surfaced, not swallowed', async () => {
  const db = fakeDb({ existing: [], insertError: { code: '42703', message: 'column "name" does not exist' } });
  await assert.rejects(() => ensureDefaultCategories(db, U, { phase: 'off' }));
});

test('refuses to run without a user id', async () => {
  await assert.rejects(() => ensureDefaultCategories(fakeDb(), null, { phase: 'off' }), /without a userId/);
});

// --- the phase flag ----------------------------------------------------------

test('ENCRYPTION_PHASE defaults to off and fails closed on anything unknown', () => {
  assert.equal(encryptionPhase({}), 'off');
  assert.equal(encryptionPhase({ ENCRYPTION_PHASE: '' }), 'off');
  for (const p of PHASES) assert.equal(encryptionPhase({ ENCRYPTION_PHASE: p.toUpperCase() }), p);
  // A typo must not silently choose a phase that writes the wrong columns.
  assert.throws(() => encryptionPhase({ ENCRYPTION_PHASE: 'encrypted' }), /not one of/);
  assert.throws(() => encryptionPhase({ ENCRYPTION_PHASE: 'on' }), /not one of/);
});

test('the phase predicates match the rollout', () => {
  assert.deepEqual(PHASES.map(writesPlaintext), [true, true, false]);
  assert.deepEqual(PHASES.map(writesCiphertext), [false, true, true]);
});

// --- the migration side ------------------------------------------------------

test('CRITICAL REGRESSION: 019 replaces handle_new_user BEFORE dropping categories.name', () => {
  const replaceAt = M019.search(/create\s+or\s+replace\s+function\s+public\.handle_new_user/i);
  assert.ok(replaceAt >= 0, 'migration 019 must replace the signup trigger function');

  const dropAt = M019.search(/alter\s+table\s+public\.categories[\s\S]*?drop\s+column\s+if\s+exists\s+name/i);
  assert.ok(dropAt >= 0, 'migration 019 must drop categories.name');
  assert.ok(
    replaceAt < dropAt,
    'the trigger must stop writing categories.name before the column is dropped, or the next ' +
      'signup raises inside the trigger and rolls back the auth.users insert',
  );
});

test("CRITICAL REGRESSION: 019's replacement trigger does not insert into categories", () => {
  const body = M019.slice(M019.search(/create\s+or\s+replace\s+function\s+public\.handle_new_user/i));
  const fn = body.slice(0, body.indexOf('$$;') + 3);
  assert.ok(fn.length > 0);
  const code = fn.replace(/--[^\n]*/g, ''); // the comment explains why it is gone
  assert.ok(
    !/insert\s+into\s+public\.categories/i.test(code),
    'the database has no encryption key, so it cannot seed categories after 019',
  );
  assert.match(code, /insert\s+into\s+public\.user_stats/i, 'user_stats seeding must survive');
});

test('the route-side seeding is race-safe because 018 adds the unique slot index', () => {
  assert.match(
    M018,
    /create\s+unique\s+index\s+if\s+not\s+exists\s+categories_user_default_slot_idx[\s\S]*?where\s+is_default/i,
    'without this, two tabs on a new account produce 24 default categories',
  );
});

test('GET /api/me actually calls the seeder — it is the only thing that does', () => {
  // The #1 failure mode on this project is a feature that exists but is not
  // reachable. After 019 the trigger no longer seeds, so if this call is ever
  // removed a new account silently gets zero categories.
  const me = readFileSync(new URL('../routes/me.js', import.meta.url), 'utf8');
  assert.match(me, /ensureDefaultCategories/);
  assert.match(me, /await\s+ensureDefaultCategories\(\s*supabase,\s*req\.user\.id\s*\)/);
});
