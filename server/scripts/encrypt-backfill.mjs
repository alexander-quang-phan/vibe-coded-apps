#!/usr/bin/env node
/**
 * Phase 9.5 step 2 of 3 — encrypt-backfill.
 *
 * Populates the `_enc` columns added by migration 012 from the existing
 * plaintext columns, using per-user AES-256-GCM (server/lib/crypto.js).
 *
 * Safety properties:
 *
 * - Terminates. Paging is keyset-based (`order by <pk>` + `.gt(pk, cursor)`),
 *   NOT "re-fetch the first page of rows that still match `<enc> is null`".
 *   The old approach relied on every write removing the row from the filter,
 *   but a row whose plaintext is NULL is written as NULL and so never leaves
 *   the filter — it is re-fetched forever. That is not hypothetical:
 *   `user_stats.monthly_limit` (migration 008) is NULL for every user until
 *   they set a limit, and `subscription_overrides.display_name` (migration 005)
 *   explicitly permits NULL. `is null` is now only an idempotency filter; the
 *   cursor, not the mutation, is what makes progress.
 *
 * - Verified against the DATABASE, not against memory. Comparing
 *   `decryptField(encryptField(x))` to `x` only re-proves the unit tests; it
 *   cannot catch a truncating column, an encoding mangle, or a write that
 *   never landed. Per row we now: encrypt -> verify in memory -> write ->
 *   re-SELECT that row's `_enc` columns -> decrypt what Postgres actually
 *   returned -> compare to the original plaintext. Only then is it counted.
 *   Migration 013 drops plaintext irreversibly on the strength of this check.
 *
 * - Aborts loudly, and logs ONLY primary keys. Any mismatch throws. Failure
 *   messages never include amounts, descriptions or notes.
 *
 * - Does NOT touch plaintext columns. This script only ever writes to the
 *   `_enc` columns; migration 013 (dropping plaintext) is a separate,
 *   explicitly-gated step.
 *
 * Usage:
 *   cd server && node scripts/encrypt-backfill.mjs --dry-run   # preview, no writes
 *   cd server && node scripts/encrypt-backfill.mjs             # for real
 *
 * Run it during a quiet period. Both paging strategies below take a snapshot
 * view of the table, so a row inserted behind the cursor mid-run can be missed;
 * a re-run is cheap, idempotent, and picks up any straggler.
 *
 * Requires (server/.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DATA_ENCRYPTION_KEY. Do NOT run this against production until Alex has
 * generated and backed up DATA_ENCRYPTION_KEY (see SECURITY.md) and applied
 * migration 012.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { encryptField, decryptField } from '../lib/crypto.js';

export const PAGE_SIZE = 500;

export const JOBS = [
  { table: 'transactions', fields: [['amount', 'amount_enc'], ['description', 'description_enc']] },
  { table: 'budgets', fields: [['amount_limit', 'amount_limit_enc']] },
  { table: 'categories', fields: [['name', 'name_enc']] },
  { table: 'savings_goals', fields: [['name', 'name_enc'], ['target_amount', 'target_amount_enc'], ['current_amount', 'current_amount_enc']] },
  { table: 'savings_contributions', fields: [['amount', 'amount_enc'], ['note', 'note_enc']] },
  { table: 'subscription_overrides', fields: [['display_name', 'display_name_enc']], pk: ['user_id', 'merchant_key'] },
  { table: 'user_stats', fields: [['monthly_limit', 'monthly_limit_enc']], pk: ['user_id'] },
  { table: 'ask_messages', fields: [['content', 'content_enc']] },
];

const uniq = (xs) => xs.filter((v, i, a) => a.indexOf(v) === i);
const pkOf = (job) => job.pk ?? ['id'];
/** Safe to log: primary key values only, never user data. */
const pkLabel = (job, row) => pkOf(job).map((k) => `${k}=${row[k]}`).join(' ');
const isBlank = (v) => v === null || v === undefined;

/**
 * Encrypt one row, write it, then re-read it from the database and prove the
 * stored bytes decrypt back to the original plaintext.
 * Returns 'encrypted' or 'nothing-to-encrypt'. Throws on any mismatch.
 */
async function processRow(supabase, job, row, { dryRun }) {
  const pk = pkOf(job);
  const patch = {};
  let hasPlaintext = false;
  for (const [plain, enc] of job.fields) {
    if (isBlank(row[plain])) {
      patch[enc] = null;
    } else {
      patch[enc] = encryptField(row.user_id, String(row[plain]));
      hasPlaintext = true;
    }
  }

  // A row with nothing but NULLs has nothing to encrypt. Counting it as done
  // (rather than writing NULL over NULL) is what stops the old infinite loop:
  // we never write, so we never expect the `is null` filter to drop it — the
  // keyset cursor has already moved past it.
  if (!hasPlaintext) return 'nothing-to-encrypt';

  // 1. In-memory check. Cheap, and catches a broken key before we touch the DB.
  for (const [plain, enc] of job.fields) {
    if (isBlank(row[plain])) continue;
    if (decryptField(row.user_id, patch[enc]) !== String(row[plain])) {
      throw new Error(`VERIFY FAILED (in-memory round-trip) ${job.table} ${pkLabel(job, row)} column=${enc}`);
    }
  }

  if (dryRun) return 'encrypted';

  // 2. Write.
  let update = supabase.from(job.table).update(patch);
  for (const k of pk) update = update.eq(k, row[k]);
  const { error: upErr } = await update;
  if (upErr) throw upErr;

  // 3. Re-SELECT what Postgres actually stored. This is the step that can catch
  //    a truncating column, an encoding mangle, or a write that silently did
  //    not land — none of which an in-memory comparison can see.
  let select = supabase.from(job.table).select(job.fields.map(([, e]) => e).join(', '));
  for (const k of pk) select = select.eq(k, row[k]);
  const { data: stored, error: selErr } = await select.maybeSingle();
  if (selErr) throw selErr;
  if (!stored) {
    throw new Error(`VERIFY FAILED (row not found on re-read after write) ${job.table} ${pkLabel(job, row)}`);
  }

  // 4. Decrypt the DATABASE's bytes and compare to the original plaintext.
  for (const [plain, enc] of job.fields) {
    const expected = isBlank(row[plain]) ? null : String(row[plain]);
    let got;
    try {
      got = decryptField(row.user_id, stored[enc]);
    } catch {
      // The underlying message is deliberately withheld: it can echo the stored
      // value, and this script must never print user data to a terminal.
      throw new Error(
        `VERIFY FAILED (stored value will not decrypt) ${job.table} ${pkLabel(job, row)} column=${enc}`,
      );
    }
    if (got !== expected) {
      throw new Error(
        `VERIFY FAILED (database round-trip mismatch) ${job.table} ${pkLabel(job, row)} column=${enc}`,
      );
    }
  }
  return 'encrypted';
}

/**
 * Single-column PK: keyset pagination.
 * Termination: `cursor` is the last row's PK and every query demands
 * `pk > cursor`, so each page covers a strictly higher, disjoint slice of a
 * finite, totally-ordered domain. Whether or not a write removes a row from
 * the `is null` filter is irrelevant to progress. The explicit non-advance
 * guard turns any violation of that assumption into a crash, not a hang.
 */
async function keysetScan(supabase, job, onRow) {
  const cursorCol = pkOf(job)[0];
  const cols = uniq([...pkOf(job), 'user_id', ...job.fields.map(([p]) => p)]).join(', ');
  const firstEnc = job.fields[0][1];
  let cursor = null;

  for (;;) {
    let q = supabase
      .from(job.table)
      .select(cols)
      .is(firstEnc, null) // idempotency only — already-encrypted rows are skipped
      .order(cursorCol, { ascending: true })
      .limit(PAGE_SIZE);
    if (cursor !== null) q = q.gt(cursorCol, cursor);

    const { data: rows, error } = await q;
    if (error) throw error;
    if (!rows.length) break;

    for (const row of rows) await onRow(row);

    const next = rows[rows.length - 1][cursorCol];
    if (next === cursor) throw new Error(`${job.table}: keyset cursor did not advance at ${cursorCol}=${next}`);
    cursor = next;
    if (rows.length < PAGE_SIZE) break;
  }
}

/**
 * Composite PK (subscription_overrides: user_id + merchant_key): ordered offset.
 * Termination: `offset` grows by rows.length >= 1 every iteration over a finite
 * table, and we stop on an empty or short page.
 * Note the `is null` filter is deliberately NOT applied here — a positional
 * window over a set that our own writes shrink would skip rows. We scan the
 * table in PK order and skip already-encrypted rows client-side instead.
 */
async function offsetScan(supabase, job, onRow, counts) {
  const pk = pkOf(job);
  const firstEnc = job.fields[0][1];
  const cols = uniq([...pk, 'user_id', ...job.fields.map(([p]) => p), firstEnc]).join(', ');
  let offset = 0;

  for (;;) {
    let q = supabase.from(job.table).select(cols);
    for (const k of pk) q = q.order(k, { ascending: true });

    const { data: rows, error } = await q.range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!rows.length) break;

    for (const row of rows) {
      if (!isBlank(row[firstEnc])) {
        counts.alreadyEncrypted += 1;
        continue;
      }
      await onRow(row);
    }

    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }
}

async function runJob(supabase, job, { dryRun, log }) {
  const counts = { encrypted: 0, nothingToEncrypt: 0, alreadyEncrypted: 0 };
  const onRow = async (row) => {
    const outcome = await processRow(supabase, job, row, { dryRun });
    if (outcome === 'encrypted') counts.encrypted += 1;
    else counts.nothingToEncrypt += 1;
  };

  if (pkOf(job).length === 1) await keysetScan(supabase, job, onRow);
  else await offsetScan(supabase, job, onRow, counts);

  const suffix = dryRun ? 'would be encrypted (dry run — nothing written)' : 'encrypted + verified against the database';
  const extras = [
    counts.nothingToEncrypt ? `${counts.nothingToEncrypt} with nothing to encrypt (all plaintext null)` : null,
    counts.alreadyEncrypted ? `${counts.alreadyEncrypted} already encrypted` : null,
  ].filter(Boolean);
  log(`${job.table}: ${counts.encrypted} rows ${suffix}${extras.length ? `, ${extras.join(', ')}` : ''}`);
  return counts;
}

export async function runBackfill({ supabase, jobs = JOBS, dryRun = false, log = console.log } = {}) {
  if (dryRun) log('DRY RUN — encrypting and verifying in memory, writing nothing.\n');
  const totals = { encrypted: 0, nothingToEncrypt: 0, alreadyEncrypted: 0 };
  for (const job of jobs) {
    const counts = await runJob(supabase, job, { dryRun, log });
    for (const k of Object.keys(totals)) totals[k] += counts[k];
  }
  log(
    dryRun
      ? `\nDry run complete — ${totals.encrypted} rows would be encrypted. Re-run without --dry-run to write.`
      : `\nBackfill complete — ${totals.encrypted} rows encrypted and verified against the database.`,
  );
  return totals;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in server/.env');
  }
  const { createClient } = await import('@supabase/supabase-js');
  await runBackfill({ supabase: createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), dryRun });
}

// Only self-execute when run directly, so tests/harnesses can import the logic
// with a fake client and never touch a real database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
