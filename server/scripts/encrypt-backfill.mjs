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
 *   explicitly permits NULL. The cursor, not the mutation, is what makes
 *   progress.
 *
 * - Repairs, per COLUMN, what the gate would reject. At phase `dual` a route
 *   encrypts only what its write touches, so rows edited mid-rollout are partly
 *   encrypted; keying on one column skipped them forever. And an edit made after
 *   going back to `off` leaves stale ciphertext. Missing, stale and orphaned
 *   columns are rewritten from the plaintext; columns already right are left
 *   alone; ciphertext this key cannot decrypt is reported, never overwritten
 *   (see columnState / processRow). [2026-11-01]
 *
 * - Verified against the DATABASE, not against memory. Comparing
 *   `decryptField(encryptField(x))` to `x` only re-proves the unit tests; it
 *   cannot catch a truncating column, an encoding mangle, or a write that
 *   never landed. Per row we now: encrypt -> verify in memory -> write ->
 *   re-SELECT that row's `_enc` columns -> decrypt what Postgres actually
 *   returned -> compare to the original plaintext. Only then is it counted.
 *   Migration 019 drops plaintext irreversibly on the strength of this check.
 *
 * - Aborts loudly, and logs ONLY primary keys. Any mismatch throws. Failure
 *   messages never include amounts, descriptions or notes.
 *
 * - Does NOT touch plaintext columns. This script only ever writes to the
 *   `_enc` columns; migration 019 (dropping plaintext) is a separate,
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
import { encryptField, decryptField, decryptRegistered } from '../lib/crypto.js';
import { fieldsByTable, fieldKey } from '../lib/encryptedFields.js';
// Moved to lib/blindIndex.js so the ROUTE codec can use them without importing
// from a maintenance script — and so the migration-019 gate stops importing them
// from the script it audits. Re-exported here because both the gate and this
// file's own tests already import them from this path.
// (imported, not just re-exported: this file calls blindValueFor itself, and
// `export ... from` creates no local binding.)
import { NORMALISERS, blindValueFor, blindValueEquals } from '../lib/blindIndex.js';

export { NORMALISERS, blindValueFor, blindValueEquals };

export const PAGE_SIZE = 500;

/**
 * SCOPE: lib/encryptedFields.js, and nothing else. Do not re-describe it here.
 *
 * This comment block used to carry its own copy of the scope — "encrypt the
 * MONEY, leave the searchable text in plaintext", with a list of columns that
 * were deliberately NOT encrypted. Alex expanded the scope on 2026-08-18 to
 * include descriptions and every free-text label, and `categories.name` followed
 * after Codex's first VERIFY. The list here was not updated, so this file spent a
 * session confidently documenting the opposite of what it does — the exact
 * hand-maintained-list drift that produced both of the data-destroying defects
 * this phase had to fix. Deleted rather than corrected, because a second copy of
 * the scope is the bug.
 *
 * What IS still deliberately plaintext is recorded once, in the registry:
 * `transactions.fx_rate` (a public market rate, and keeping it numeric keeps the
 * `fx_rate > 0` CHECK enforceable).
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
 * What the gate would say about one column of one row — its per-row checks in
 * scripts/verify-encryption.mjs verifyRows, column by column:
 *
 *   'ok'          ciphertext matches the plaintext, or both are NULL
 *   'missing'     plaintext present, no ciphertext
 *   'stale'       ciphertext decrypts, but not to the plaintext beside it
 *   'orphaned'    ciphertext present, plaintext NULL
 *   'unreadable'  ciphertext this key cannot decrypt
 *
 * The first three wrongs are repaired from the plaintext, which is the value the
 * user sees at `dual`. 'stale' and 'orphaned' are what an edit leaves behind
 * after the runbook's Step 3 undo (back to `off`, where only plaintext is
 * written). 'unreadable' is NOT repaired — see processRow.
 *
 * Compares RAW text: routing an amount through decryptAmount would turn a stored
 * "12.50" into 12.5 and mismatch every two-decimal amount.
 */
function columnState(job, f, row) {
  const plain = isBlank(row[f.column]) ? null : String(row[f.column]);
  if (isBlank(row[f.enc])) return plain === null ? 'ok' : 'missing';
  if (plain === null) return 'orphaned';
  try {
    return decryptField(fieldKey(job.table, f.column), row.user_id, row[f.enc]) === plain ? 'ok' : 'stale';
  } catch {
    return 'unreadable';
  }
}

/**
 * Repair whatever is wrong with this row, write it, then re-read it from the
 * database and prove the stored bytes decrypt back to the plaintext.
 * Returns { outcome, unreadable }: outcome is 'encrypted', 'already-encrypted' or
 * 'nothing-to-encrypt'; unreadable lists the `_enc` columns left alone because
 * this key cannot decrypt them. Throws on any mismatch.
 *
 * Decided per column, never per row. At ENCRYPTION_PHASE=dual the routes encrypt
 * only the columns a write touches (encodeWrite keeps a partial update partial),
 * so a row created at `off` and edited at `dual` is HALF-encrypted: a PATCH of a
 * transaction's amount writes amount_enc and leaves description_enc NULL. This
 * used to skip any row whose FIRST `_enc` column was set, so that row was never
 * finished, the gate failed on it, and no re-run could repair it. [2026-11-01]
 */
async function processRow(supabase, job, row, { dryRun }) {
  const pk = pkOf(job);
  const states = job.fields.map((f) => [f, columnState(job, f, row)]);
  // A NULL plaintext beside a NULL `_enc` is 'ok' (original_amount on every
  // home-currency transaction) — treating it as missing would rewrite that row
  // on every run.
  const rewrite = states.filter(([, s]) => s === 'missing' || s === 'stale' || s === 'orphaned').map(([f]) => f);
  // Never overwritten. With one key there is no honest way to produce this, so
  // the likeliest cause is that server/.env holds a different key from the one
  // production encrypted with — and re-encrypting under it would make the gate
  // PASS on values the live app can no longer read. Left for the gate to fail on;
  // runJob says why.
  const unreadable = states.filter(([, s]) => s === 'unreadable').map(([f]) => f.enc);
  // A blind index needs writing when it does not recompute from the plaintext
  // beside it — the gate's own test, so anything it would reject, this repairs.
  const staleBlind = (job.blind ?? []).filter(
    (b) => !blindValueEquals(row[b.column], blindValueFor(job.table, b, row)),
  );

  if (!rewrite.length && !staleBlind.length) {
    // Never written, so never expected to leave any filter: the cursor (or the
    // offset) has already moved past it, which is what keeps the scan finite.
    const outcome = job.fields.every((f) => isBlank(row[f.column])) ? 'nothing-to-encrypt' : 'already-encrypted';
    return { outcome, unreadable };
  }

  // Only what is wrong. Ciphertext that already matches is left exactly as it is
  // — re-encrypting it from this scan's snapshot could only make it older.
  const patch = {};
  for (const f of rewrite) {
    patch[f.enc] = isBlank(row[f.column])
      ? null // 'orphaned': the plaintext was cleared, so is its ciphertext
      : encryptField(fieldKey(job.table, f.column), row.user_id, String(row[f.column]));
  }
  // An index rides in the same statement as its ciphertext, so a row is never
  // left with one and not the other.
  for (const b of staleBlind) patch[b.column] = blindValueFor(job.table, b, row);

  // 1. In-memory check. Cheap, and catches a broken key before we touch the DB.
  //    Compare RAW text — routing an amount through decryptAmount would turn a
  //    stored "12.50" into 12.5 and mismatch every two-decimal amount.
  for (const f of rewrite) {
    if (isBlank(row[f.column])) continue;
    if (decryptField(fieldKey(job.table, f.column), row.user_id, patch[f.enc]) !== String(row[f.column])) {
      throw new Error(`VERIFY FAILED (in-memory round-trip) ${job.table} ${pkLabel(job, row)} column=${f.enc}`);
    }
    // Separately enforce the registered kind, so an amount that would become 0 or
    // NaN in the app is refused BEFORE it is written and certified.
    try {
      decryptRegistered(fieldKey(job.table, f.column), row.user_id, patch[f.enc]);
    } catch (err) {
      throw new Error(
        `VERIFY FAILED (not a valid ${f.kind}) ${job.table} ${pkLabel(job, row)} column=${f.enc}`,
      );
    }
  }

  if (dryRun) return { outcome: 'encrypted', unreadable };

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
    //    correct copy dropped by migration 019.  [audit 2026-08-18, High]
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

    // 4. Decrypt the DATABASE's bytes and compare to the DATABASE's plaintext —
    //    for what THIS run wrote. A column a route wrote is the gate's to judge:
    //    failing here on one the backfill cannot repair would abort every re-run
    //    on the same row, and the rollback would erase this run's good work.
    //    (A cleared column reads back NULL on both sides; decryptField(null) is null.)
    for (const f of rewrite) {
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
    for (const b of staleBlind) {
      const want = blindValueFor(job.table, b, { ...stored, user_id: row.user_id });
      if (!blindValueEquals(stored[b.column], want)) {
        throw new Error(
          `VERIFY FAILED (blind index does not match its plaintext) ` +
            `${job.table} ${pkLabel(job, row)} column=${b.column}`,
        );
      }
    }
  } catch (err) {
    await rollbackEnc(supabase, job, row, Object.keys(patch), err);
    throw err;
  }

  return { outcome: 'encrypted', unreadable };
}

/**
 * Undo an unverified write by NULLing the columns THIS run wrote.
 *
 * Why this has to exist (found by adversarial audit 2026-08-09, and required by
 * the spec all along): the write at step 2 commits BEFORE verification. If
 * anything after it fails — including a transient PostgREST timeout on the
 * re-read, which says nothing about the data — the row stays committed with a
 * NON-NULL `_enc`. A re-run treats a non-NULL `_enc` as done, so on the re-run
 * this script's own header invites, that column is now INVISIBLE. It is never
 * re-encrypted and never re-verified, the run prints "Backfill complete", and
 * migration 019 drops its plaintext on the strength of a check that never
 * actually passed for it.
 *
 * NULLing the columns puts them back in the re-run's sights. Only the ones we
 * wrote: ciphertext a route wrote correctly is not ours to erase. Blind indexes
 * we wrote go back too — leaving one behind means a row whose ciphertext was
 * rolled back is still findable by merchant, the exact leak this is for. If the
 * rollback ITSELF fails we must be loud: that is the one state a re-run cannot
 * repair on its own.
 */
async function rollbackEnc(supabase, job, row, columns, cause) {
  const patch = Object.fromEntries(columns.map((c) => [c, null]));
  try {
    let undo = supabase.from(job.table).update(patch);
    for (const k of pkOf(job)) undo = undo.eq(k, row[k]);
    const { error } = await undo;
    if (error) throw error;
  } catch {
    cause.message +=
      `\n  !! ROLLBACK ALSO FAILED for ${job.table} ${pkLabel(job, row)}.` +
      `\n  !! This row is committed with UNVERIFIED ciphertext and a re-run will SKIP it.` +
      `\n  !! Set its ${columns.join(', ')} back to NULL by hand before re-running,` +
      `\n  !! and do NOT run migration 019 until you have.`;
  }
}

/**
 * Every column processRow decides from: each plaintext beside its `_enc`, and each
 * blind index beside its source. Both scans read the same set, so neither can
 * judge a row on a column it never selected — PostgREST would hand back nothing
 * for it, and an `_enc` that was never read looks exactly like a missing one.
 */
const scanColumns = (job) => uniq([
  ...pkOf(job), 'user_id',
  ...job.fields.flatMap((f) => [f.column, f.enc]),
  ...(job.blind ?? []).flatMap((b) => [b.from, b.column]),
]).join(', ');

/**
 * Single-column PK: keyset pagination.
 * Termination: `cursor` is the last row's PK and every query demands
 * `pk > cursor`, so each page covers a strictly higher, disjoint slice of a
 * finite, totally-ordered domain. Whether or not a write changes a row is
 * irrelevant to progress. The explicit non-advance guard turns any violation of
 * that assumption into a crash, not a hang.
 *
 * There is no server-side "already done" filter. It used to be
 * `.is(<first _enc column>, null)`, which hid every half-encrypted row whose
 * first column a route had already written (see processRow). Each row's own
 * columns decide instead. That reads the whole table, which at Trim's size is
 * seconds — the gate already reads every row twice.
 */
async function keysetScan(supabase, job, onRow) {
  const cursorCol = pkOf(job)[0];
  const cols = scanColumns(job);
  let cursor = null;

  for (;;) {
    let q = supabase
      .from(job.table)
      .select(cols)
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
 * No server-side filter, for a second reason besides the keyset one: a positional
 * window over a set that our own writes shrink skips rows — encrypt the first
 * 500, they leave the filter, and `range(500, 999)` now starts 500 rows further
 * into a set that is 500 rows shorter. We scan every row in PK order and
 * processRow decides. (This path used to skip a row client-side on its FIRST
 * `_enc` column alone — the same half-encrypted-row bug as keysetScan.)
 */
async function offsetScan(supabase, job, onRow) {
  const pk = pkOf(job);
  const cols = scanColumns(job);
  let offset = 0;

  for (;;) {
    let q = supabase.from(job.table).select(cols);
    for (const k of pk) q = q.order(k, { ascending: true });

    const { data: rows, error } = await q.range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!rows.length) break;

    for (const row of rows) await onRow(row);

    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }
}

/**
 * Read-only pass over EVERY table before the first write: refuse to start if any
 * existing ciphertext will not decrypt with this key. [2026-11-01, review]
 *
 * The likeliest cause is that server/.env holds a different key from the one
 * production encrypts with. Skipping just the unreadable values was not enough:
 * the run would still fill every gap and rewrite every blind index (under another
 * key each one looks stale) with values the live app cannot read, and a gate run
 * under the same wrong key would agree with it. So: nothing is written, in any
 * table, until every existing value decrypts. Runs in --dry-run too, which is
 * where the runbook has Alex look first.
 */
async function preflightKey(supabase, jobs, log) {
  let readable = 0;
  const unreadable = [];
  for (const job of jobs) {
    const onRow = async (row) => {
      for (const f of job.fields) {
        const state = columnState(job, f, row);
        if (state === 'unreadable') unreadable.push(`${job.table} ${pkLabel(job, row)} ${f.enc}`);
        else if (!isBlank(row[f.enc]) && state !== 'orphaned') readable += 1;
      }
    };
    if (pkOf(job).length === 1) await keysetScan(supabase, job, onRow);
    else await offsetScan(supabase, job, onRow);
  }
  if (unreadable.length) {
    const shown = unreadable.slice(0, 20).map((u) => `    ${u}`).join('\n');
    const more = unreadable.length > 20 ? `\n    …and ${unreadable.length - 20} more` : '';
    throw new Error(
      `REFUSING TO START — ${unreadable.length} encrypted value(s) will not decrypt with this key ` +
        `(${readable} other(s) did). Nothing was written.\n${shown}${more}\n` +
        '  If NONE decrypt: DATA_ENCRYPTION_KEY in server/.env is not the key production uses. Compare\n' +
        '  server/.env, Vercel and your offline backup — all three must be identical.\n' +
        '  If only a few fail: those values are damaged. Once you are sure the key matches the backup\n' +
        '  and Vercel, set the listed columns back to NULL and re-run.',
    );
  }
  log(
    readable
      ? `Key check: ${readable} existing encrypted value(s) decrypt with this key.\n`
      : 'Key check: no existing encrypted values, so the key could not be checked against production.\n' +
          "  Confirm the gate's key fingerprint matches before trusting any PASS.\n",
  );
}

async function runJob(supabase, job, { dryRun, log }) {
  const counts = { encrypted: 0, nothingToEncrypt: 0, alreadyEncrypted: 0, scanned: 0, unreadable: 0 };
  const onRow = async (row) => {
    counts.scanned += 1;
    const { outcome, unreadable } = await processRow(supabase, job, row, { dryRun });
    if (outcome === 'encrypted') counts.encrypted += 1;
    else if (outcome === 'already-encrypted') counts.alreadyEncrypted += 1;
    else counts.nothingToEncrypt += 1;
    if (unreadable.length) {
      counts.unreadable += unreadable.length;
      log(`  !! ${job.table} ${pkLabel(job, row)}: this key cannot decrypt ${unreadable.join(', ')} — left as it is`);
    }
  };

  if (pkOf(job).length === 1) await keysetScan(supabase, job, onRow);
  else await offsetScan(supabase, job, onRow);

  const suffix = dryRun ? 'would be encrypted (dry run — nothing written)' : 'encrypted + verified against the database';
  const extras = [
    counts.nothingToEncrypt ? `${counts.nothingToEncrypt} with nothing to encrypt (all plaintext null)` : null,
    counts.alreadyEncrypted ? `${counts.alreadyEncrypted} already encrypted` : null,
  ].filter(Boolean);
  log(`${job.table}: ${counts.encrypted} rows ${suffix}${extras.length ? `, ${extras.join(', ')}` : ''}`);
  // "0 rows encrypted" is the SAME output for "already done" and for "pointed at
  // the wrong database / the table is empty". Say which. Every row is scanned now,
  // already-encrypted ones included, so zero scanned means zero rows exist.
  // [audit 2026-08-18, High — vacuous success]
  if (counts.scanned === 0) {
    log(`  ^ NOTE: ${job.table} returned NO ROWS AT ALL. Either the table is empty,`);
    log(`    or this is the wrong database. Confirm before trusting a PASS.`);
  }
  return counts;
}

export async function runBackfill({ supabase, jobs = JOBS, dryRun = false, log = console.log } = {}) {
  if (dryRun) log('DRY RUN — encrypting and verifying in memory, writing nothing.\n');
  await preflightKey(supabase, jobs, log);
  const totals = { encrypted: 0, nothingToEncrypt: 0, alreadyEncrypted: 0, scanned: 0, unreadable: 0 };
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
        'Do NOT treat this run as authorising migration 019.',
    );
  }
  if (totals.unreadable > 0) {
    log(
      `\nWARNING: ${totals.unreadable} encrypted value(s) could not be decrypted with this key and were left\n` +
        'as they are (the rows are listed above by primary key). The gate will fail on them.\n' +
        'STOP and check DATA_ENCRYPTION_KEY in server/.env is the exact key set in Vercel: a\n' +
        'different key would also have encrypted every gap filled in this run. Only once you\n' +
        'are sure the key is right, set those columns back to NULL and re-run this script.',
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
