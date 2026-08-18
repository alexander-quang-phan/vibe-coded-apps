/**
 * Keeps lib/encryptedFields.js, migration 012 and migration 019 in step.
 *
 * Both of the worst defects the 2026-08-18 audit found were DRIFT, not logic:
 *
 *   - migration 016 added transactions.original_amount a month after 012 froze
 *     its column list, so a money column existed that no list knew about — and
 *     because amount = original_amount * fx_rate, the "encrypted" amount was
 *     recoverable by multiplication.
 *   - the draft migration 019 in the plan document still dropped five columns
 *     from the ORIGINAL scope whose `_enc` twins were never created, so running
 *     it would have destroyed every description, category name, goal name,
 *     contribution note and subscription label in the database.
 *
 * Neither is catchable by reading one file. These tests read all three.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ENCRYPTED_FIELDS, BLIND_INDEXES, fieldsByTable } from '../lib/encryptedFields.js';
import { BARRIER_TABLE, COUNTERS_RPC } from '../scripts/verify-encryption.mjs';

/**
 * Strip `--` comments before parsing. Both migrations DISCUSS columns and even
 * quote the dangerous July rename in their headers, so parsing the raw text
 * makes the prose look like DDL. (Caught by this file's own rename test.)
 */
const stripComments = (text) => text.replace(/--[^\n]*/g, '');
const sql = (f) => stripComments(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
const M012 = sql('012_encryption_columns.sql');
const M018 = sql('018_encryption_text_columns.sql');
const M013 = sql('019_encryption_drop_plaintext.sql'); // renumbered 013 -> 019
// 012 (money) and 018 (free text + blind indexes) are both additive, both
// unapplied, and applied in the same step. For "does every column exist?" they
// are one migration.
const ADDITIVE = `${M012}\n${M018}`;

/** `alter table public.X ... add column if not exists Y text` pairs in a migration. */
function addedColumns(text) {
  const out = new Set();
  for (const stmt of text.split(';')) {
    const t = stmt.match(/alter\s+table\s+public\.(\w+)/i);
    if (!t) continue;
    for (const m of stmt.matchAll(/add\s+column\s+if\s+not\s+exists\s+(\w+)/gi)) out.add(`${t[1]}.${m[1]}`);
  }
  return out;
}

function droppedColumns(text) {
  const out = new Set();
  for (const stmt of text.split(';')) {
    const t = stmt.match(/alter\s+table\s+public\.(\w+)/i);
    if (!t) continue;
    for (const m of stmt.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?(\w+)/gi)) out.add(`${t[1]}.${m[1]}`);
  }
  return out;
}

test('the additive migrations create an _enc column for every registered field', () => {
  const added = addedColumns(ADDITIVE);
  const missing = ENCRYPTED_FIELDS
    .map((f) => `${f.table}.${f.enc}`)
    .filter((c) => !added.has(c));
  assert.deepEqual(missing, [], `registered but never created by migration 012: ${missing.join(', ')}`);
});

test('the additive migrations create nothing that is not registered', () => {
  const registered = new Set([
    ...ENCRYPTED_FIELDS.map((f) => `${f.table}.${f.enc}`),
    ...BLIND_INDEXES.map((b) => `${b.table}.${b.column}`),
  ]);
  const orphans = [...addedColumns(ADDITIVE)].filter((c) => !registered.has(c));
  assert.deepEqual(orphans, [], `created by a migration but absent from lib/encryptedFields.js: ${orphans.join(', ')}`);
});

test('every blind index has a column in the additive migrations', () => {
  const added = addedColumns(ADDITIVE);
  const missing = BLIND_INDEXES.map((b) => `${b.table}.${b.column}`).filter((c) => !added.has(c));
  assert.deepEqual(missing, [], `blind index registered but never created: ${missing.join(', ')}`);
});

test('every blind index is derived from a column that is actually encrypted or dropped', () => {
  // A blind index over a column that stays in plaintext is pointless — the
  // plaintext is right there. Each `from` must itself be encrypted, or be the
  // subscription primary key that 013 replaces.
  const encrypted = new Set(ENCRYPTED_FIELDS.map((f) => `${f.table}.${f.column}`));
  const dropped = droppedColumns(M013);
  for (const b of BLIND_INDEXES) {
    const src = `${b.table}.${b.from}`;
    assert.ok(
      encrypted.has(src) || dropped.has(src),
      `${b.table}.${b.column} indexes ${src}, which is neither encrypted nor dropped — the plaintext stays readable beside it`,
    );
  }
});

test('the subscription primary key moves off the plaintext merchant key', () => {
  // merchant_key holds the merchant name AND an amount bucket, and it is the PK,
  // so it survives every _enc column. 013 must repoint the key before dropping it.
  assert.match(M013, /add constraint subscription_overrides_pkey primary key \(user_id, merchant_key_hmac\)/);
  assert.ok(droppedColumns(M013).has('subscription_overrides.merchant_key'));
});

test('migration 019 drops every plaintext column whose ciphertext twin exists', () => {
  const dropped = droppedColumns(M013);
  const missing = ENCRYPTED_FIELDS
    .map((f) => `${f.table}.${f.column}`)
    .filter((c) => !dropped.has(c));
  assert.deepEqual(missing, [], `encrypted but plaintext never dropped: ${missing.join(', ')}`);
});

test('migration 019 drops NOTHING that has no encrypted or hashed replacement', () => {
  // The exact defect in the July draft: it dropped transactions.description,
  // categories.name, savings_goals.name, savings_contributions.note and
  // subscription_overrides.display_name, none of which 012 ever twinned.
  //
  // A dropped column is safe if EITHER an _enc twin holds its value, OR a blind
  // index replaces it. subscription_overrides.merchant_key is the second kind:
  // it is a lookup key, not readable content, so merchant_key_hmac replaces it
  // rather than encrypting it. Nothing else may be dropped.
  const registered = new Set([
    ...ENCRYPTED_FIELDS.map((f) => `${f.table}.${f.column}`),
    ...BLIND_INDEXES.map((b) => `${b.table}.${b.from}`),
  ]);
  const unsafe = [...droppedColumns(M013)].filter((c) => !registered.has(c));
  assert.deepEqual(
    unsafe,
    [],
    `migration 019 would DESTROY columns with no encrypted replacement: ${unsafe.join(', ')}`,
  );
});

test('migration 019 renames nothing', () => {
  // A rename turns a numeric column into text under a still-running old server,
  // which then writes bare plaintext into the column the new code reads as
  // ciphertext. Keeping the _enc suffix forever is what makes the cutover safe.
  const renames = [...M013.matchAll(/rename\s+column\s+(\w+)\s+to\s+(\w+)/gi)].map((m) => `${m[1]} -> ${m[2]}`);
  assert.deepEqual(renames, [], `migration 019 must not rename columns: ${renames.join(', ')}`);
});

test('every registered table has a primary key the backfill can page on', () => {
  for (const t of fieldsByTable()) {
    assert.ok(Array.isArray(t.pk) && t.pk.length >= 1, `${t.table} has no usable primary key`);
  }
});

test('descriptions are encrypted and searchable, not one or the other', () => {
  // The whole point of the blind index: encrypting description without it would
  // silently break merchant memory forever.
  const tx = ENCRYPTED_FIELDS.filter((f) => f.table === 'transactions').map((f) => f.column);
  assert.ok(tx.includes('description'), 'transactions.description must be encrypted');
  const idx = BLIND_INDEXES.filter((b) => b.table === 'transactions' && b.from === 'description');
  assert.ok(idx.length >= 1, 'encrypting description without a blind index breaks merchant memory');
});

test('the fx reconstruction hole is closed: amount and original_amount are both encrypted', () => {
  // amount = original_amount * fx_rate. Encrypting only one of the two leaves
  // the other recoverable, which is exactly the state migration 016 created.
  const tx = ENCRYPTED_FIELDS.filter((f) => f.table === 'transactions').map((f) => f.column);
  assert.ok(tx.includes('amount'), 'transactions.amount must be encrypted');
  assert.ok(tx.includes('original_amount'), 'transactions.original_amount must be encrypted or amount is derivable');
});


// --- ordering and post-drop invariants (Codex stage-4 VERIFY, 2026-08-18) ----

test('the destructive migration sorts LAST among the encryption migrations', () => {
  // As 013 it sorted BEFORE 018, so applying migrations in filename order — the
  // obvious instinct — would have dropped the plaintext before 018 created the
  // columns meant to replace it. Prose said "run me last"; the filename said the
  // opposite, and the filename is what gets followed.
  const names = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  const additive = names.filter((n) => /encryption_(columns|text_columns)/.test(n));
  const destructive = names.find((n) => /encryption_drop_plaintext/.test(n));
  assert.ok(destructive, 'the drop migration must exist');
  for (const a of additive) {
    assert.ok(a < destructive, `${a} must sort before ${destructive}, or the drop runs first`);
  }
  assert.equal(names[names.length - 1], destructive, 'the drop must be the last migration of all');
});

test('every NOT NULL plaintext column has its invariant restored on the _enc column', () => {
  // 012/018 create the _enc columns NULLABLE, because the backfill fills them one
  // row at a time. Once the plaintext is dropped, the database stops guaranteeing
  // that a transaction has an amount unless 019 re-applies it.
  const setNotNull = new Set(
    [...M013.matchAll(/alter\s+table\s+public\.(\w+)\s+alter\s+column\s+(\w+)\s+set\s+not\s+null/gi)]
      .map((m) => `${m[1]}.${m[2]}`),
  );
  const missing = ENCRYPTED_FIELDS
    .filter((f) => f.notNull)
    .map((f) => `${f.table}.${f.enc}`)
    .filter((c) => !setNotNull.has(c));
  assert.deepEqual(missing, [], `NOT NULL lost on: ${missing.join(', ')}`);
});

test('nullable columns are NOT given a NOT NULL they never had', () => {
  const setNotNull = new Set(
    [...M013.matchAll(/alter\s+table\s+public\.(\w+)\s+alter\s+column\s+(\w+)\s+set\s+not\s+null/gi)]
      .map((m) => `${m[1]}.${m[2]}`),
  );
  const wrong = ENCRYPTED_FIELDS
    .filter((f) => !f.notNull)
    .map((f) => `${f.table}.${f.enc}`)
    .filter((c) => setNotNull.has(c));
  assert.deepEqual(wrong, [], `these were nullable and must stay nullable: ${wrong.join(', ')}`);
});

test('the subscription merchant key keeps an ENCRYPTED source, not only a hash', () => {
  // A hash is one-way. With only merchant_key_hmac, a master-key rotation could
  // never recompute the primary key and the table would be unrebuildable.
  const enc = ENCRYPTED_FIELDS.find((f) => f.table === 'subscription_overrides' && f.column === 'merchant_key');
  assert.ok(enc, 'merchant_key must have an encrypted, recoverable copy');
  assert.ok(BLIND_INDEXES.some((b) => b.table === 'subscription_overrides' && b.from === 'merchant_key'));
});

test('custom category names are encrypted', () => {
  // routes/categories.js:127 lets a user POST any name and :159 rename one, so
  // "only the 12 seeded defaults" was false.
  assert.ok(ENCRYPTED_FIELDS.some((f) => f.table === 'categories' && f.column === 'name'));
  assert.ok(BLIND_INDEXES.some((b) => b.table === 'categories' && b.from === 'name'),
    'the keyword lookup does .eq(name, …) in the database and needs an index');
});


// --- the enforced write barrier (Codex stage-4 RE-VERIFY finding 2) ----------

const M018A = sql('018a_encryption_write_barrier.sql');

test('the write barrier guards every table that has an encrypted column', () => {
  // A table left unguarded is a table the app can still write during the window
  // migration 019 runs in — and a write that lands inside an already-scanned page
  // moves neither the row count nor the digest, so nothing else would see it.
  // Read the declared list itself, not any quoted word in the file — a test that
  // passes because it scanned the prose is not a test.
  const block = M018A.match(/guarded\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/i);
  assert.ok(block, 'the migration must declare its guarded tables as one array');
  const guarded = new Set([...block[1].matchAll(/'(\w+)'/g)].map((m) => m[1]));
  assert.ok(guarded.size >= 10, `only parsed ${guarded.size} guarded tables`);
  const missing = fieldsByTable().map((j) => j.table).filter((t) => !guarded.has(t));
  assert.deepEqual(missing, [], `no write barrier on: ${missing.join(', ')}`);
});

test('the barrier migration sorts between the additive ones and the drop', () => {
  const names = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  const barrier = names.find((n) => /encryption_write_barrier/.test(n));
  const text = names.find((n) => /encryption_text_columns/.test(n));
  const destructive = names.find((n) => /encryption_drop_plaintext/.test(n));
  assert.ok(barrier, 'the write barrier migration must exist');
  assert.ok(text < barrier, `${text} must sort before ${barrier}`);
  assert.ok(barrier < destructive, `${barrier} must sort before ${destructive}`);
});

test('the gate looks for the exact barrier objects the migration creates', () => {
  // Same class of drift as the registry: the gate reading a table name the
  // migration never created would fail closed forever, and reading one it renamed
  // would fail OPEN if the read were ever made lenient.
  assert.match(M018A, new RegExp(`create table if not exists public\\.${BARRIER_TABLE}\\b`, 'i'));
  assert.match(M018A, new RegExp(`create or replace function public\\.${COUNTERS_RPC}\\b`, 'i'));
});

test('the barrier blocks writes at statement level and can always be released', () => {
  // Row-level would cost a lookup per row on every write forever. And the flag
  // table itself must carry no trigger, or engaging the barrier would lock in the
  // ability to release it.
  assert.match(M018A, /for each statement execute function public\.reject_writes_during_cutover/i);
  assert.ok(
    !/create trigger[^;]*on public\.encryption_cutover/i.test(M018A),
    'the flag table must not guard itself',
  );
});

test('the counter RPC is not exposed to anon or authenticated', () => {
  assert.match(M018A, /revoke execute on function public\.encryption_write_counters\(\) from anon, authenticated, public/i);
  assert.match(M018A, /grant execute on function public\.encryption_write_counters\(\) to service_role/i);
});
