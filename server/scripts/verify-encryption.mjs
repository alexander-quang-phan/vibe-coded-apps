#!/usr/bin/env node
/**
 * Phase 9.5 — the completeness gate for migration 013.
 *
 * Migration 013 IRREVERSIBLY drops the plaintext columns. Before Phase 10's
 * audit, the only thing authorising it was the backfill's own exit code plus a
 * manual click-through of the UI. Neither is evidence:
 *
 *   - The backfill's exit code says "the rows I looked at were fine". It cannot
 *     speak for a row inserted by the live app AFTER its cursor passed, and the
 *     script's own header admits a straggler can be missed.
 *   - A click-through proves a handful of screens render. It cannot prove that
 *     all N rows across seven tables carry valid ciphertext.
 *
 * This script asks the DATABASE the only question that matters:
 *
 *     is there any row where the plaintext is present but the ciphertext is not?
 *
 * It exits 0 only when the answer is zero everywhere. Anything else exits 1.
 * Wire it in as the literal gate: run 013 ONLY if this exits 0, in the same
 * quiet window, with the app paused or read-only.
 *
 * It also spot-checks that stored ciphertext actually decrypts — a column full
 * of non-NULL garbage would pass a pure NULL check.
 *
 *   cd server && node scripts/verify-encryption.mjs
 *   cd server && node scripts/verify-encryption.mjs --sample 200
 *
 * Read-only: this script never writes.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { decryptField } from '../lib/crypto.js';
import { JOBS } from './encrypt-backfill.mjs';

const DEFAULT_SAMPLE = 50;

const pkOf = (job) => job.pk ?? ['id'];
const pkLabel = (job, row) => pkOf(job).map((k) => `${k}=${row[k]}`).join(' ');

/**
 * Count rows that migration 013 would destroy: plaintext present, ciphertext
 * missing. Uses a HEAD count so it never pulls user data over the wire.
 */
async function countUnencrypted(supabase, job, plain, enc) {
  const { count, error } = await supabase
    .from(job.table)
    .select(plain, { count: 'exact', head: true })
    .not(plain, 'is', null)
    .is(enc, null);
  if (error) throw error;
  return count ?? 0;
}

/**
 * A NULL check alone would pass a column full of non-NULL garbage. Pull a
 * bounded sample and prove the stored bytes actually decrypt to the plaintext
 * still sitting beside them.
 */
async function sampleDecrypts(supabase, job, plain, enc, limit) {
  const cols = [...new Set([...pkOf(job), 'user_id', plain, enc])].join(', ');
  const { data, error } = await supabase
    .from(job.table)
    .select(cols)
    .not(enc, 'is', null)
    .limit(limit);
  if (error) throw error;

  const failures = [];
  for (const row of data ?? []) {
    let got;
    try {
      got = decryptField(row.user_id, row[enc]);
    } catch {
      // Never echo the value — it is user data.
      failures.push(`${job.table} ${pkLabel(job, row)} ${enc}: will not decrypt`);
      continue;
    }
    if (row[plain] !== null && row[plain] !== undefined && got !== String(row[plain])) {
      failures.push(`${job.table} ${pkLabel(job, row)} ${enc}: decrypts to something else`);
    }
  }
  return { checked: (data ?? []).length, failures };
}

export async function verifyEncryption({
  supabase,
  jobs = JOBS,
  sample = DEFAULT_SAMPLE,
  log = console.log,
} = {}) {
  let missing = 0;
  let checked = 0;
  const failures = [];

  for (const job of jobs) {
    for (const [plain, enc] of job.fields) {
      const n = await countUnencrypted(supabase, job, plain, enc);
      const s = await sampleDecrypts(supabase, job, plain, enc, sample);
      missing += n;
      checked += s.checked;
      failures.push(...s.failures);

      const verdict = n === 0 && s.failures.length === 0 ? 'ok' : 'PROBLEM';
      log(
        `  [${verdict}] ${job.table}.${plain} -> ${enc}: ` +
          `${n} row(s) plaintext-but-not-encrypted, ${s.checked} sampled, ${s.failures.length} bad`,
      );
    }
  }

  const pass = missing === 0 && failures.length === 0;
  log('');
  if (pass) {
    log(`PASS — nothing would be lost. ${checked} ciphertext value(s) sampled and all decrypted.`);
    log('Migration 013 may proceed IN THIS WINDOW, with the app paused or read-only.');
  } else {
    log(`FAIL — ${missing} row(s) have plaintext with no ciphertext; ${failures.length} bad ciphertext value(s).`);
    for (const f of failures.slice(0, 20)) log(`    ${f}`);
    if (failures.length > 20) log(`    ...and ${failures.length - 20} more`);
    log('\nDO NOT RUN MIGRATION 013. Re-run the backfill, then re-run this gate.');
  }
  return { pass, missing, checked, failures };
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--sample');
  const sample = i === -1 ? DEFAULT_SAMPLE : Number(argv[i + 1]);
  if (!Number.isFinite(sample) || sample <= 0) throw new Error('--sample must be a positive number');

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
