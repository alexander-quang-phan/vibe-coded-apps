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
import { ENCRYPTED_FIELDS, fieldsByTable } from '../lib/encryptedFields.js';

/**
 * Strip `--` comments before parsing. Both migrations DISCUSS columns and even
 * quote the dangerous July rename in their headers, so parsing the raw text
 * makes the prose look like DDL. (Caught by this file's own rename test.)
 */
const stripComments = (text) => text.replace(/--[^\n]*/g, '');
const sql = (f) => stripComments(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
const M012 = sql('012_encryption_columns.sql');
const M013 = sql('013_encryption_drop_plaintext.sql');

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

test('migration 012 creates an _enc column for every registered field', () => {
  const added = addedColumns(M012);
  const missing = ENCRYPTED_FIELDS
    .map((f) => `${f.table}.${f.enc}`)
    .filter((c) => !added.has(c));
  assert.deepEqual(missing, [], `registered but never created by migration 012: ${missing.join(', ')}`);
});

test('migration 012 creates nothing that is not registered', () => {
  const registered = new Set(ENCRYPTED_FIELDS.map((f) => `${f.table}.${f.enc}`));
  const orphans = [...addedColumns(M012)].filter((c) => !registered.has(c));
  assert.deepEqual(orphans, [], `created by 012 but absent from lib/encryptedFields.js: ${orphans.join(', ')}`);
});

test('migration 013 drops every plaintext column whose ciphertext twin exists', () => {
  const dropped = droppedColumns(M013);
  const missing = ENCRYPTED_FIELDS
    .map((f) => `${f.table}.${f.column}`)
    .filter((c) => !dropped.has(c));
  assert.deepEqual(missing, [], `encrypted but plaintext never dropped: ${missing.join(', ')}`);
});

test('migration 013 drops NOTHING that has no ciphertext twin', () => {
  // The exact defect in the July draft: it dropped transactions.description,
  // categories.name, savings_goals.name, savings_contributions.note and
  // subscription_overrides.display_name, none of which 012 ever twinned.
  const registered = new Set(ENCRYPTED_FIELDS.map((f) => `${f.table}.${f.column}`));
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

test('the fx reconstruction hole is closed: amount and original_amount are both encrypted', () => {
  // amount = original_amount * fx_rate. Encrypting only one of the two leaves
  // the other recoverable, which is exactly the state migration 016 created.
  const tx = ENCRYPTED_FIELDS.filter((f) => f.table === 'transactions').map((f) => f.column);
  assert.ok(tx.includes('amount'), 'transactions.amount must be encrypted');
  assert.ok(tx.includes('original_amount'), 'transactions.original_amount must be encrypted or amount is derivable');
});
