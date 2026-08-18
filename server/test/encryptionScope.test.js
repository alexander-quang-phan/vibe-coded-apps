/**
 * Keeps lib/encryptedFields.js, migration 012 and migration 013 in step.
 *
 * Both of the worst defects the 2026-08-18 audit found were DRIFT, not logic:
 *
 *   - migration 016 added transactions.original_amount a month after 012 froze
 *     its column list, so a money column existed that no list knew about — and
 *     because amount = original_amount * fx_rate, the "encrypted" amount was
 *     recoverable by multiplication.
 *   - the draft migration 013 in the plan document still dropped five columns
 *     from the ORIGINAL scope whose `_enc` twins were never created, so running
 *     it would have destroyed every description, category name, goal name,
 *     contribution note and subscription label in the database.
 *
 * Neither is catchable by reading one file. These tests read all three.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENCRYPTED_FIELDS, BLIND_INDEXES, fieldsByTable } from '../lib/encryptedFields.js';

/**
 * Strip `--` comments before parsing. Both migrations DISCUSS columns and even
 * quote the dangerous July rename in their headers, so parsing the raw text
 * makes the prose look like DDL. (Caught by this file's own rename test.)
 */
const stripComments = (text) => text.replace(/--[^\n]*/g, '');
const sql = (f) => stripComments(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
const M012 = sql('012_encryption_columns.sql');
const M018 = sql('018_encryption_text_columns.sql');
const M013 = sql('013_encryption_drop_plaintext.sql');
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

test('migration 013 drops every plaintext column whose ciphertext twin exists', () => {
  const dropped = droppedColumns(M013);
  const missing = ENCRYPTED_FIELDS
    .map((f) => `${f.table}.${f.column}`)
    .filter((c) => !dropped.has(c));
  assert.deepEqual(missing, [], `encrypted but plaintext never dropped: ${missing.join(', ')}`);
});

test('migration 013 drops NOTHING that has no encrypted or hashed replacement', () => {
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
    `migration 013 would DESTROY columns with no encrypted replacement: ${unsafe.join(', ')}`,
  );
});

test('migration 013 renames nothing', () => {
  // A rename turns a numeric column into text under a still-running old server,
  // which then writes bare plaintext into the column the new code reads as
  // ciphertext. Keeping the _enc suffix forever is what makes the cutover safe.
  const renames = [...M013.matchAll(/rename\s+column\s+(\w+)\s+to\s+(\w+)/gi)].map((m) => `${m[1]} -> ${m[2]}`);
  assert.deepEqual(renames, [], `migration 013 must not rename columns: ${renames.join(', ')}`);
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
