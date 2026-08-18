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
import { encryptField, decryptField, blindIndex } from '../lib/crypto.js';
import { fieldsByTable, fieldKey } from '../lib/encryptedFields.js';
import { normaliseMerchant, normaliseMerchantFirstWord } from '../lib/merchant.js';

/** Must match the read path exactly — see lib/merchant.js. */
export const NORMALISERS = {
  merchant: normaliseMerchant,
  merchantFirstWord: normaliseMerchantFirstWord,
  identity: (v) => (v === null || v === undefined ? null : String(v)),
};

/** The blind-index value a row should carry, recomputable from its plaintext. */
export function blindValueFor(table, b, row) {
  const normalise = NORMALISERS[b.normalise];
  if (!normalise) throw new Error(`Unknown normaliser '${b.normalise}' for ${table}.${b.column}`);
  return blindIndex(fieldKey(table, b.column), row.user_id, normalise(row[b.from]));
}

export const PAGE_SIZE = 500;

/**
 * SCOPE (re-decided 2026-08-09, before this script had ever been run):
 * encrypt the MONEY, leave the searchable text in plaintext.
 *
 * Every amount column, plus `ask_messages.content` (free text that could
 * contain anything and that nothing queries). Deliberately NOT encrypted:
 *
 *   transactions.description  — routes/categories.js:89 runs `.ilike()` on it
 *                               in the DATABASE for merchant memory (Task 6.9).
 *                               You cannot ILIKE a ciphertext, and decrypting
 *                               after fetch does not help. Encrypting it would
 *                               silently break that feature forever.
 *   categories.name           — lib/categoryKeywords.js matches on it by name.
 *   savings_goals.name,
 *   savings_contributions.note,
 *   subscription_overrides.display_name
 *                             — labels, not amounts. Nothing queries them, so
 *                               they could be added cheaply later if wanted.
 *
 * This is the bulk of the privacy benefit (how much you have and move) at a
 * fraction of the risk: no feature coupling, and roughly half the route sweep.
 * `transactions.description` can be added later behind a blind index (an HMAC
 * of the normalised merchant, searched instead of the ciphertext).
 */
/**
 * Derived from lib/encryptedFields.js — the ONE list. This used to be a literal
 * array here, which is how `transactions.original_amount` (migration 016) ended
 * up encrypted by nothing: a money column added a month later that no list knew
 * about. verify-encryption.mjs also used to import THIS constant, so the gate's
 * scope was defined by the script it was auditing; both now read the registry.
 */
export const JOBS = fieldsByTable();

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
  for (const f of job.fields) {
    if (isBlank(row[f.column])) {
      patch[f.enc] = null;
    } else {
      patch[f.enc] = encryptField(fieldKey(job.table, f.column), row.user_id, String(row[f.column]));
      hasPlaintext = true;
    }
  }

  // A row with nothing but NULLs has nothing to encrypt. Counting it as done
  // (rather than writing NULL over NULL) is what stops the old infinite loop:
  // we never write, so we never expect the `is null` filter to drop it — the
  // keyset cursor has already moved past it.
  // Blind indexes ride along in the same patch. They are derived from the same
  // plaintext, so they must be written in the same statement — a row with a
  // ciphertext but no index is invisible to merchant memory, and a row with an
  // index but no ciphertext is worse.
  for (const b of job.blind ?? []) {
    patch[b.column] = blindValueFor(job.table, b, row);
    if (patch[b.column] !== null) hasPlaintext = true;
  }

  if (!hasPlaintext) return 'nothing-to-encrypt';

  // 1. In-memory check. Cheap, and catches a broken key before we touch the DB.
  for (const f of job.fields) {
    if (isBlank(row[f.column])) continue;
    if (decryptField(fieldKey(job.table, f.column), row.user_id, patch[f.enc]) !== String(row[f.column])) {
      throw new Error(`VERIFY FAILED (in-memory round-trip) ${job.table} ${pkLabel(job, row)} column=${f.enc}`);
    }
  }

  if (dryRun) return 'encrypted';

  // 2. Write.
  let update = supabase.from(job.table).update(patch);
  for (const k of pk) update = update.eq(k, row[k]);
  const { error: upErr } = await update;
  if (upErr) throw upErr;

  // 3-4. Verify against the DATABASE. Anything that goes wrong from here on
  // leaves a row that is committed but UNVERIFIED, so it must be rolled back —
  // see rollbackEnc below for why that is not optional.
  try {
    // 3. Re-SELECT what Postgres actually stored — BOTH columns. Re-reading the
    //    plaintext as well is what makes step 4 honest: comparing the stored
    //    ciphertext against our in-memory snapshot only proves we wrote what we
    //    meant to, and says nothing about whether the row still holds that value.
    //    The live app is up during the backfill (that is the whole point of
    //    dual-write), so a user editing 250 -> 25 between our SELECT and our
    //    UPDATE would otherwise be "verified" as 250 and then have its only
    //    correct copy dropped by migration 013.  [audit 2026-08-18, High]
    const cols = uniq([
      'user_id',
      ...job.fields.map((f) => f.column),
      ...job.fields.map((f) => f.enc),
      ...(job.blind ?? []).flatMap((b) => [b.from, b.column]),
    ]).join(', ');
    let select = supabase.from(job.table).select(cols);
    for (const k of pk) select = select.eq(k, row[k]);
    const { data: stored, error: selErr } = await select.maybeSingle();
    if (selErr) throw selErr;
    if (!stored) {
      throw new Error(`VERIFY FAILED (row not found on re-read after write) ${job.table} ${pkLabel(job, row)}`);
    }

    // 4. Decrypt the DATABASE's bytes and compare to the DATABASE's plaintext.
    for (const f of job.fields) {
      const expected = isBlank(stored[f.column]) ? null : String(stored[f.column]);
      let got;
      try {
        got = decryptField(fieldKey(job.table, f.column), row.user_id, stored[f.enc]);
      } catch {
        // The underlying message is deliberately withheld: it can echo the
        // stored value, and this script must never print user data.
        throw new Error(
          `VERIFY FAILED (stored value will not decrypt) ${job.table} ${pkLabel(job, row)} column=${f.enc}`,
        );
      }
      if (got !== expected) {
        throw new Error(
          `VERIFY FAILED (database round-trip mismatch — the row may have been edited mid-run; ` +
            `re-run to repair) ${job.table} ${pkLabel(job, row)} column=${f.enc}`,
        );
      }
    }

    // Blind indexes are deterministic, so "correct" means "recomputes to the
    // same value from the plaintext the database currently holds". A silently
    // wrong index does not throw anywhere — merchant memory just stops
    // suggesting, forever, with no error to notice.
    for (const b of job.blind ?? []) {
      const want = blindValueFor(job.table, b, { ...stored, user_id: row.user_id });
      if (stored[b.column] !== want) {
        throw new Error(
          `VERIFY FAILED (blind index does not match its plaintext) ` +
            `${job.table} ${pkLabel(job, row)} column=${b.column}`,
        );
      }
    }
  } catch (err) {
    await rollbackEnc(supabase, job, row, err);
    throw err;
  }

  return 'encrypted';
}

/**
 * Undo an unverified write by NULLing the `_enc` columns again.
 *
 * Why this has to exist (found by adversarial audit 2026-08-09, and required by
 * the spec all along): the write at step 2 commits BEFORE verification. If
 * anything after it fails — including a transient PostgREST timeout on the
 * re-read, which says nothing about the data — the row stays committed with a
 * NON-NULL `_enc`. The idempotency filter in keysetScan is `.is(<enc>, null)`,
 * so on the re-run this script's own header invites, that row is now INVISIBLE.
 * It is never re-encrypted and never re-verified, the run prints "Backfill
 * complete", and migration 013 drops its plaintext on the strength of a check
 * that never actually passed for it.
 *
 * NULLing the columns puts the row back in the filter's sights so a re-run
 * fixes it. If the rollback ITSELF fails we must be loud: that is the one state
 * a re-run cannot repair on its own.
 */
async function rollbackEnc(supabase, job, row, cause) {
  const patch = {};
  for (const f of job.fields) patch[f.enc] = null;
  // Blind indexes go back too. Leaving one behind means a row whose ciphertext
  // was rolled back is still findable by merchant — the exact leak this is for.
  for (const b of job.blind ?? []) patch[b.column] = null;
  try {
    let undo = supabase.from(job.table).update(patch);
    for (const k of pkOf(job)) undo = undo.eq(k, row[k]);
    const { error } = await undo;
    if (error) throw error;
  } catch {
    cause.message +=
      `\n  !! ROLLBACK ALSO FAILED for ${job.table} ${pkLabel(job, row)}.` +
      `\n  !! This row is committed with UNVERIFIED ciphertext and a re-run will SKIP it.` +
      `\n  !! Set its ${job.fields.map((f) => f.enc).join(', ')} back to NULL by hand before re-running,` +
      `\n  !! and do NOT run migration 013 until you have.`;
  }
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
  const cols = uniq([
    ...pkOf(job), 'user_id',
    ...job.fields.map((f) => f.column),
    ...(job.blind ?? []).map((b) => b.from),
  ]).join(', ');
  const firstEnc = job.fields[0].enc;
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
 *
 * Removed on 2026-08-18 as unreachable dead code, then RESTORED the same day
 * when `subscription_overrides.display_name` entered scope — encrypting every
 * description while leaving the recurring-merchant list readable would have been
 * pointless. It has tests this time.
 *
 * Termination: `offset` grows by rows.length >= 1 every iteration over a finite
 * table, and we stop on an empty or short page.
 *
 * The `is null` idempotency filter is deliberately NOT applied here. A positional
 * window over a set that our own writes shrink skips rows: encrypt the first 500,
 * they leave the filter, and `range(500, 999)` now starts 500 rows further into a
 * set that is 500 rows shorter. We scan in PK order and skip already-encrypted
 * rows client-side instead.
 */
async function offsetScan(supabase, job, onRow, counts) {
  const pk = pkOf(job);
  const firstEnc = job.fields[0].enc;
  const cols = uniq([
    ...pk, 'user_id',
    ...job.fields.map((f) => f.column),
    ...(job.blind ?? []).map((b) => b.from),
    firstEnc,
  ]).join(', ');
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
  const counts = { encrypted: 0, nothingToEncrypt: 0, alreadyEncrypted: 0, scanned: 0 };
  const onRow = async (row) => {
    counts.scanned += 1;
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
  // "0 rows encrypted" is the SAME output for "already done" and for "pointed at
  // the wrong database / the table is empty / the filter matched nothing". Say
  // which. [audit 2026-08-18, High — vacuous success]
  if (counts.scanned === 0) {
    log(`  ^ NOTE: ${job.table} returned NO ROWS AT ALL. Either every row is already`);
    log(`    encrypted, or this is the wrong database. Confirm before trusting a PASS.`);
  }
  return counts;
}

export async function runBackfill({ supabase, jobs = JOBS, dryRun = false, log = console.log } = {}) {
  if (dryRun) log('DRY RUN — encrypting and verifying in memory, writing nothing.\n');
  const totals = { encrypted: 0, nothingToEncrypt: 0, alreadyEncrypted: 0, scanned: 0 };
  for (const job of jobs) {
    const counts = await runJob(supabase, job, { dryRun, log });
    for (const k of Object.keys(totals)) totals[k] += counts[k];
  }
  log(
    dryRun
      ? `\nDry run complete — ${totals.encrypted} rows would be encrypted (${totals.scanned} scanned). ` +
          `Re-run without --dry-run to write.`
      : `\nBackfill complete — ${totals.encrypted} rows encrypted and verified against the database ` +
          `(${totals.scanned} scanned across ${jobs.length} tables).`,
  );
  if (totals.scanned === 0) {
    log(
      '\nWARNING: not a single row was scanned in ANY table. This is what an empty or\n' +
        'wrong database looks like, and it is NOT evidence that encryption is complete.\n' +
        'Do NOT treat this run as authorising migration 013.',
    );
  }
  return totals;
}

export const KNOWN_FLAGS = new Set(['--dry-run']);

/**
 * Fail on anything we don't recognise. `argv.includes('--dry-run')` alone means
 * `--dryrun`, `--dry_run` or `--dry-run=true` are silently treated as "no flags"
 * — i.e. a typo performs a LIVE production run against real user data. Refusing
 * to start is the only safe reading of an unrecognised flag.
 */
export function parseArgs(argv) {
  // NOT `a.startsWith('-') && ...`. That let a DASHLESS typo through: `node
  // encrypt-backfill.mjs dry-run` parsed as "no flags" and performed a LIVE
  // write pass against real user data — the exact outcome the guard exists to
  // prevent, reached by the likeliest typo of all. [audit 2026-08-18]
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    throw new Error(
      `Unknown option(s): ${unknown.join(' ')}\n` +
        `Did you mean --dry-run? Refusing to run: an unrecognised argument would otherwise ` +
        `perform a LIVE run against real data.`,
    );
  }
  return { dryRun: argv.includes('--dry-run') };
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
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
