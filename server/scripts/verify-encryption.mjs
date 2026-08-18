#!/usr/bin/env node
/**
 * Phase 9.5 — the completeness gate for migration 013.
 *
 * Migration 013 IRREVERSIBLY drops the plaintext columns. This script's exit
 * code is the ONLY thing that authorises it. A backfill's exit code says "the
 * rows I looked at were fine"; a UI click-through proves a handful of screens
 * render. Neither speaks for every row.
 *
 * REWRITTEN 2026-08-18 after an adversarial audit rated the previous version
 * unsound as a gate. It asked exactly one question — "is the plaintext present
 * while the ciphertext is NULL?" — and was structurally blind to the likelier
 * failure: a row where BOTH are present and they DISAGREE. That is what every
 * missed UPDATE path in the route sweep produces, and what any edit made between
 * the backfill and the drop produces. It then "spot-checked" 50 unordered rows,
 * which cannot see a row it never fetched.
 *
 * The four questions it now asks, per encrypted column:
 *
 *   1. plaintext present, ciphertext NULL   -> rows 013 would DESTROY.
 *   2. plaintext NULL, ciphertext present   -> stale ciphertext for a value the
 *                                              user has since CLEARED. After 013
 *                                              the cleared value silently comes
 *                                              back. The old gate's sample skipped
 *                                              this case by construction.
 *   3. both present, they DISAGREE          -> stale ciphertext for a value the
 *                                              user has since EDITED. Cannot be
 *                                              expressed as a database filter
 *                                              (the database cannot decrypt), so
 *                                              every row is fetched and compared.
 *   4. ciphertext present but will not decrypt.
 *
 * Question 3 is why this reads EVERY row by default rather than sampling. Trim
 * has five users; full verification costs seconds and is the only thing that
 * makes a PASS mean what it says. `--sample N` still exists for a large table,
 * but a sampled run prints INCOMPLETE and is NOT an authorisation.
 *
 * It also re-counts after the read pass. If anything changed while it ran, the
 * app was not actually paused and the PASS is void.
 *
 *   cd server && node scripts/verify-encryption.mjs
 *   cd server && node scripts/verify-encryption.mjs --sample 200   # NOT a gate
 *
 * Read-only: this script never writes.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { decryptField } from '../lib/crypto.js';
import { fieldsByTable, fieldKey } from '../lib/encryptedFields.js';
import { blindValueFor } from './encrypt-backfill.mjs';

const PAGE = 500;

// Scope comes from the shared registry, NOT from encrypt-backfill.mjs. The gate
// importing its scope from the script it audits meant a column dropped from that
// script's list silently vanished from the gate too — it would then certify a
// drop it had never checked. [audit 2026-08-18, High]
export const JOBS = fieldsByTable();

const pkOf = (job) => job.pk ?? ['id'];
const pkLabel = (job, row) => pkOf(job).map((k) => `${k}=${row[k]}`).join(' ');
const isBlank = (v) => v === null || v === undefined;

/**
 * Exact count. Throws rather than defaulting when PostgREST returns no count:
 * `count ?? 0` made the completeness check FAIL OPEN — a request that came back
 * without a count read as "zero rows at risk" and authorised the drop.
 * [audit 2026-08-18, Medium]
 */
async function exactCount(supabase, table, build) {
  const { count, error } = await build(supabase.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw error;
  if (count === null || count === undefined) {
    throw new Error(
      `${table}: PostgREST returned no count. Refusing to treat an absent count as zero — ` +
        `that is how a broken query authorises an irreversible drop.`,
    );
  }
  return count;
}

const countPlaintextWithoutCipher = (supabase, job, f) =>
  exactCount(supabase, job.table, (q) => q.not(f.column, 'is', null).is(f.enc, null));

const countCipherWithoutPlaintext = (supabase, job, f) =>
  exactCount(supabase, job.table, (q) => q.is(f.column, null).not(f.enc, 'is', null));

/**
 * Fetch rows and prove the stored ciphertext decrypts back to the plaintext
 * sitting beside it. Paginated by primary key so a table larger than one page is
 * fully covered and the order is deterministic (the old version's unordered
 * LIMIT re-checked the same rows every run).
 */
async function verifyRows(supabase, job, { limit, log }) {
  const cursorCol = pkOf(job)[0];
  const cols = [...new Set([
    ...pkOf(job), 'user_id',
    ...job.fields.flatMap((f) => [f.column, f.enc]),
    ...(job.blind ?? []).flatMap((b) => [b.from, b.column]),
  ])].join(', ');
  const failures = [];
  let checked = 0;
  let cursor = null;

  for (;;) {
    if (limit !== null && checked >= limit) break;
    const take = limit === null ? PAGE : Math.min(PAGE, limit - checked);
    let q = supabase.from(job.table).select(cols).order(cursorCol, { ascending: true }).limit(take);
    if (cursor !== null) q = q.gt(cursorCol, cursor);

    const { data, error } = await q;
    if (error) throw error;
    if (!data || !data.length) break;

    for (const row of data) {
      checked += 1;
      for (const f of job.fields) {
        const plain = isBlank(row[f.column]) ? null : String(row[f.column]);
        const cipher = row[f.enc];

        if (isBlank(cipher)) {
          // Counted exactly by countPlaintextWithoutCipher; nothing to decrypt.
          continue;
        }
        let got;
        try {
          got = decryptField(fieldKey(job.table, f.column), row.user_id, cipher);
        } catch {
          // Never echo the value — it is user data.
          failures.push(`${job.table} ${pkLabel(job, row)} ${f.enc}: will not decrypt`);
          continue;
        }
        if (got !== plain) {
          failures.push(
            `${job.table} ${pkLabel(job, row)} ${f.enc}: ciphertext is STALE — it does not match the ` +
              `plaintext beside it, so 013 would make the wrong value permanent`,
          );
        }
      }

      // Blind indexes are deterministic, so the only correct value is the one
      // that recomputes from the plaintext this row currently holds. A wrong
      // index throws nowhere and breaks nothing loudly — merchant memory just
      // stops suggesting forever. After 013 the plaintext is gone and it cannot
      // be recomputed at all, so this is the last moment it is checkable.
      for (const b of job.blind ?? []) {
        const want = blindValueFor(job.table, b, row);
        if (row[b.column] !== want) {
          failures.push(
            `${job.table} ${pkLabel(job, row)} ${b.column}: blind index does not match its plaintext — ` +
              `after 013 this row becomes unfindable and cannot be repaired`,
          );
        }
      }
    }

    const next = data[data.length - 1][cursorCol];
    if (next === cursor) throw new Error(`${job.table}: cursor did not advance at ${cursorCol}=${next}`);
    cursor = next;
    if (data.length < take) break;
  }
  return { checked, failures };
}

export async function verifyEncryption({
  supabase,
  jobs = JOBS,
  sample = null, // null = every row, which is what a real gate requires
  log = console.log,
} = {}) {
  let missing = 0;
  let stale = 0;
  let checked = 0;
  const failures = [];
  const before = new Map();

  for (const job of jobs) {
    for (const f of job.fields) {
      const key = fieldKey(job.table, f.column);
      const noCipher = await countPlaintextWithoutCipher(supabase, job, f);
      const noPlain = await countCipherWithoutPlaintext(supabase, job, f);
      before.set(key, [noCipher, noPlain]);
      missing += noCipher;
      stale += noPlain;

      const verdict = noCipher === 0 && noPlain === 0 ? 'ok' : 'PROBLEM';
      log(
        `  [${verdict}] ${key} -> ${f.enc}: ` +
          `${noCipher} plaintext-but-not-encrypted, ${noPlain} encrypted-but-plaintext-cleared`,
      );
    }

    const r = await verifyRows(supabase, job, { limit: sample, log });
    checked += r.checked;
    failures.push(...r.failures);
  }

  // Re-count. If a number moved while we were reading, the app was NOT paused
  // and this PASS describes a database that no longer exists.
  const drifted = [];
  for (const job of jobs) {
    for (const f of job.fields) {
      const key = fieldKey(job.table, f.column);
      const [wasNoCipher, wasNoPlain] = before.get(key);
      const nowNoCipher = await countPlaintextWithoutCipher(supabase, job, f);
      const nowNoPlain = await countCipherWithoutPlaintext(supabase, job, f);
      if (nowNoCipher !== wasNoCipher || nowNoPlain !== wasNoPlain) drifted.push(key);
    }
  }

  const complete = sample === null;
  const pass = missing === 0 && stale === 0 && failures.length === 0 && drifted.length === 0 && complete;

  log('');
  if (drifted.length) {
    log(`FAIL — the database CHANGED while this gate ran: ${drifted.join(', ')}.`);
    log('The app is still writing. Pause it (and the 03:00 recurrences cron) and start again.');
  }
  if (!complete) {
    log(`INCOMPLETE — ran with --sample ${sample}, so ${checked} row(s) were checked and the rest were not.`);
    log('A sampled run is NOT an authorisation for migration 013. Re-run with no --sample.');
  }
  if (pass) {
    log(`PASS — every row checked (${checked}). No plaintext would be lost and no ciphertext is stale.`);
    log('Migration 013 may proceed IN THIS WINDOW, with the app paused and the cron disabled.');
    log('Re-run this gate immediately before 013 as the final check.');
  } else if (!drifted.length && complete) {
    log(
      `FAIL — ${missing} row(s) have plaintext with no ciphertext; ${stale} row(s) have ciphertext ` +
        `for a cleared value; ${failures.length} bad or stale ciphertext value(s).`,
    );
    for (const f of failures.slice(0, 20)) log(`    ${f}`);
    if (failures.length > 20) log(`    ...and ${failures.length - 20} more`);
    log('\nDO NOT RUN MIGRATION 013. Re-run the backfill, then re-run this gate.');
  }
  return { pass, missing, stale, checked, failures, drifted, complete };
}

/** Strict: an unrecognised or malformed flag must not quietly run a weaker check. */
export function parseArgs(argv) {
  let sample = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sample') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--sample must be followed by a positive whole number');
      sample = n;
      i += 1;
    } else if (a.startsWith('--sample=')) {
      // The old parser used argv.indexOf('--sample'), so `--sample=200` matched
      // nothing and silently ran at the default depth while looking deliberate.
      const n = Number(a.slice('--sample='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error('--sample must be followed by a positive whole number');
      sample = n;
    } else {
      throw new Error(`Unknown option: ${a}. The only option is --sample <n>, and a sampled run is not a gate.`);
    }
  }
  return { sample };
}

async function main() {
  const { sample } = parseArgs(process.argv.slice(2));
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in server/.env');
  }
  const { createClient } = await import('@supabase/supabase-js');
  const { pass } = await verifyEncryption({
    supabase: createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY),
    sample,
  });
  process.exit(pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
