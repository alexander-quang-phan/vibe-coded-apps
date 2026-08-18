#!/usr/bin/env node
/**
 * Phase 9.5 — the completeness gate for migration 019.
 *
 * Migration 019 IRREVERSIBLY drops the plaintext columns. This script's exit
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
 *   1. plaintext present, ciphertext NULL   -> rows 019 would DESTROY.
 *   2. plaintext NULL, ciphertext present   -> stale ciphertext for a value the
 *                                              user has since CLEARED. After 019
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
import { createHash } from 'node:crypto';
import { decryptField, decryptRegistered } from '../lib/crypto.js';
import { fieldsByTable, fieldKey } from '../lib/encryptedFields.js';
import { blindValueFor, blindValueEquals } from './encrypt-backfill.mjs';

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
 * Fetch EVERY row and prove the stored ciphertext decrypts back to the plaintext
 * beside it.
 *
 * REWRITTEN 2026-08-18 after Codex reproduced a false PASS: the previous version
 * keyset-paged on `pkOf(job)[0]` alone, so on a composite key
 * (subscription_overrides: user_id + merchant_key) the cursor was `user_id`.
 * After the first page `.gt('user_id', <same user>)` matched nothing, the scan
 * stopped, and row 501 of 501 was never verified — while the gate printed PASS.
 *
 * Now: ordered offset paging over ALL primary key columns. Offset paging is
 * correct here precisely because this script never writes — the old objection
 * (our own writes shrink the window) does not apply to a read-only gate. It is
 * also naturally safe against a server-side row cap, because the offset advances
 * by the number of rows actually returned rather than the number requested.
 *
 * The real guarantee, though, is the caller's `checked === total` assertion. Any
 * paging bug at all, present or future, fails the gate instead of hiding a row.
 */
async function verifyRows(supabase, job, { limit }) {
  const pk = pkOf(job);
  const cols = [...new Set([
    ...pk, 'user_id',
    ...job.fields.flatMap((f) => [f.column, f.enc]),
    ...(job.blind ?? []).flatMap((b) => [b.from, b.column]),
  ])].join(', ');
  const failures = [];
  // A digest of everything read, so a second pass can prove nothing moved. A
  // count cannot: editing an amount from 250 to 25 leaves every count identical,
  // which is exactly how the previous drift check reported "no drift" while the
  // ciphertext went stale. [Codex stage-4 VERIFY, 2026-08-18]
  const digest = createHash('sha256');
  let checked = 0;
  let offset = 0;

  for (;;) {
    if (limit !== null && checked >= limit) break;
    const take = limit === null ? PAGE : Math.min(PAGE, limit - checked);
    let q = supabase.from(job.table).select(cols);
    for (const k of pk) q = q.order(k, { ascending: true });

    const { data, error } = await q.range(offset, offset + take - 1);
    if (error) throw error;
    if (!data || !data.length) break;

    for (const row of data) {
      checked += 1;
      digest.update(pk.map((k) => String(row[k])).join('\u0000'));

      for (const f of job.fields) {
        const plain = isBlank(row[f.column]) ? null : String(row[f.column]);
        const cipher = row[f.enc];
        digest.update(`\u0001${f.column}=${plain}\u0001${f.enc}=${cipher}`);

        if (isBlank(cipher)) {
          // Do NOT lean on countPlaintextWithoutCipher for this. That count runs
          // at a different instant, so a row inserted between the count and this
          // pass is invisible to both — the count already returned 0, and this
          // loop used to `continue`. Checking it here puts every state in one
          // pass, covered by the digest. (Caught by this file's own drift test.)
          if (plain !== null) {
            failures.push(
              `${job.table} ${pkLabel(job, row)} ${f.enc}: plaintext present with NO ciphertext — ` +
                `019 would destroy this value`,
            );
          }
          continue;
        }
        let got;
        try {
          // Compare the RAW decrypted text, not a kind-converted value. Routing an
          // amount through decryptAmount here would turn a stored "12.50" into the
          // number 12.5, whose String() is "12.5" — a false MISMATCH on every
          // two-decimal amount in the database, i.e. a gate that can never pass.
          got = decryptField(fieldKey(job.table, f.column), row.user_id, cipher);
        } catch {
          // Never echo the value — it is user data.
          failures.push(`${job.table} ${pkLabel(job, row)} ${f.enc}: will not decrypt`);
          continue;
        }
        try {
          // Separately, enforce the registered `kind`. This is what stops the gate
          // certifying an amount under weaker rules than the runtime: a column
          // decrypting to "" or "abc" round-trips fine as text but becomes 0 or
          // NaN in the app once the plaintext is gone.
          decryptRegistered(fieldKey(job.table, f.column), row.user_id, cipher);
        } catch {
          failures.push(
            `${job.table} ${pkLabel(job, row)} ${f.enc}: decrypts, but not as a valid ${f.kind} — ` +
              `after 019 this becomes 0 or NaN in the app`,
          );
        }
        if (got !== plain) {
          failures.push(
            `${job.table} ${pkLabel(job, row)} ${f.enc}: ciphertext is STALE — it does not match the ` +
              `plaintext beside it, so 019 would make the wrong value permanent`,
          );
        }
      }

      for (const b of job.blind ?? []) {
        digest.update(`\u0002${b.column}=${JSON.stringify(row[b.column])}`);
        const want = blindValueFor(job.table, b, row);
        if (!blindValueEquals(row[b.column], want)) {
          failures.push(
            `${job.table} ${pkLabel(job, row)} ${b.column}: blind index does not match its plaintext — ` +
              `after 019 this row becomes unfindable and cannot be repaired`,
          );
        }
      }
    }

    offset += data.length; // advance by what we GOT, so a server row cap cannot skip rows
  }
  return { checked, failures, digest: digest.digest('base64') };
}

/**
 * Preflight: prove WHICH database, WHICH role and WHICH key this is about to
 * authorise a destructive migration against. A PASS is meaningless if it was
 * computed against staging, through the anon key (where RLS hides most rows and
 * every count reads as a comforting zero), or under a different encryption key
 * than production runs.  [Codex stage-4 VERIFY, 2026-08-18]
 */
export function describeTarget(env = process.env) {
  const url = env.SUPABASE_URL ?? '';
  const host = url.replace(/^https?:\/\//, '').split('/')[0] || '(unset)';

  let role = 'unknown';
  try {
    const payload = JSON.parse(Buffer.from(String(env.SUPABASE_SERVICE_ROLE_KEY).split('.')[1], 'base64').toString());
    role = payload.role ?? 'unknown';
  } catch {
    role = 'unparseable';
  }

  // A short fingerprint of the encryption key — enough for Alex to confirm it is
  // the key he backed up, revealing nothing. NEVER print the key itself.
  const keyRaw = env.DATA_ENCRYPTION_KEY;
  const keyFingerprint = keyRaw
    ? createHash('sha256').update(keyRaw).digest('hex').slice(0, 12)
    : null;

  return { host, role, keyFingerprint };
}

export async function verifyEncryption({
  supabase,
  jobs = JOBS,
  sample = null, // null = every row, which is what a real gate requires
  log = console.log,
  env = process.env,
} = {}) {
  let missing = 0;
  let stale = 0;
  let checked = 0;
  const failures = [];
  const skipped = [];
  const digests = new Map();

  // --- preflight: what exactly are we authorising a destructive migration on?
  const target = describeTarget(env);
  log(`  target database : ${target.host}`);
  log(`  connecting as   : ${target.role}`);
  log(`  encryption key  : ${target.keyFingerprint ? `fingerprint ${target.keyFingerprint}` : 'NOT SET'}`);
  log('');
  if (target.role !== 'service_role') {
    // Through the anon key, RLS hides other users' rows and every count reads as
    // a comforting zero — a PASS that describes almost none of the database.
    failures.push(
      `connected as '${target.role}', not 'service_role' — row-level security would hide most of the ` +
        `database and every count would read as zero. This gate cannot speak for data it cannot see.`,
    );
  }
  if (!target.keyFingerprint) {
    failures.push('DATA_ENCRYPTION_KEY is not set — nothing could have been decrypted to verify.');
  }

  for (const job of jobs) {
    for (const f of job.fields) {
      const key = fieldKey(job.table, f.column);
      const noCipher = await countPlaintextWithoutCipher(supabase, job, f);
      const noPlain = await countCipherWithoutPlaintext(supabase, job, f);
      missing += noCipher;
      stale += noPlain;

      const verdict = noCipher === 0 && noPlain === 0 ? 'ok' : 'PROBLEM';
      log(
        `  [${verdict}] ${key} -> ${f.enc}: ` +
          `${noCipher} plaintext-but-not-encrypted, ${noPlain} encrypted-but-plaintext-cleared`,
      );
    }

    // Exact table total, then prove we actually looked at every one of them.
    const total = await exactCount(supabase, job.table, (q) => q);
    const r = await verifyRows(supabase, job, { limit: sample });
    checked += r.checked;
    failures.push(...r.failures);
    digests.set(job.table, r.digest);

    // THE invariant. Any paging bug — the composite-key cursor that stopped after
    // one page, a server row cap, a future refactor — fails the gate instead of
    // silently leaving rows unverified. This is what Codex's 501-row probe broke.
    if (sample === null && r.checked !== total) {
      skipped.push(`${job.table}: ${total} rows exist but only ${r.checked} were verified`);
    }
    log(`  [${r.checked === total || sample !== null ? 'ok' : 'PROBLEM'}] ${job.table}: ${r.checked}/${total} rows verified`);
  }

  // --- drift: re-read everything and compare digests.
  // A COUNT cannot detect drift. Editing an amount from 250 to 25 leaves every
  // count identical, which is precisely how the previous version reported "no
  // drift" while the ciphertext went stale beneath it. A digest over each row's
  // keys, plaintext, ciphertext and blind indexes detects an edit, an insert and
  // a delete alike. [Codex stage-4 VERIFY, 2026-08-18]
  const drifted = [];
  if (sample === null) {
    for (const job of jobs) {
      const again = await verifyRows(supabase, job, { limit: null });
      if (again.digest !== digests.get(job.table)) drifted.push(job.table);
    }
  }

  const complete = sample === null;
  const pass =
    missing === 0 &&
    stale === 0 &&
    failures.length === 0 &&
    drifted.length === 0 &&
    skipped.length === 0 &&
    complete;

  log('');
  if (skipped.length) {
    log('FAIL — rows exist that this gate never verified:');
    for (const sk of skipped) log(`    ${sk}`);
    log('A gate that cannot account for every row cannot authorise dropping every row.');
  }
  if (drifted.length) {
    log(`FAIL — the database CHANGED while this gate ran: ${drifted.join(', ')}.`);
    log('The app is still writing. Pause it (and the 03:00 recurrences cron) and start again.');
  }
  if (!complete) {
    log(`INCOMPLETE — ran with --sample ${sample}, so ${checked} row(s) were checked and the rest were not.`);
    log('A sampled run is NOT an authorisation for migration 019. Re-run with no --sample.');
  }
  if (pass) {
    log(`PASS — every row verified (${checked}). No plaintext would be lost and no ciphertext is stale.`);
    log(`Target ${target.host}, key fingerprint ${target.keyFingerprint}.`);
    log('Migration 019 may proceed IN THIS WINDOW, with the app paused and the cron disabled.');
    log('Re-run this gate immediately before 019 as the final check.');
  } else if (!drifted.length && !skipped.length && complete) {
    log(
      `FAIL — ${missing} row(s) have plaintext with no ciphertext; ${stale} row(s) have ciphertext ` +
        `for a cleared value; ${failures.length} bad or stale value(s).`,
    );
    for (const f of failures.slice(0, 20)) log(`    ${f}`);
    if (failures.length > 20) log(`    ...and ${failures.length - 20} more`);
    log('\nDO NOT RUN MIGRATION 019. Re-run the backfill, then re-run this gate.');
  }
  return { pass, missing, stale, checked, failures, drifted, skipped, complete, target };
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
