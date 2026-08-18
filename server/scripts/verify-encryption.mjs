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
 * The four questions it asks, per encrypted column:
 *
 *   1. plaintext present, ciphertext NULL   -> rows 019 would DESTROY.
 *   2. plaintext NULL, ciphertext present   -> stale ciphertext for a value the
 *                                              user has since CLEARED. After 019
 *                                              the cleared value silently comes
 *                                              back.
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
 * WHAT PROVES THE DATABASE HELD STILL  [Codex stage-4 RE-VERIFY, 2026-08-18]
 * ---------------------------------------------------------------------------
 * Not this script. An earlier version claimed that reading everything twice and
 * comparing a digest proved quiescence. Codex reproduced the counter-example:
 * delete an already-scanned row and insert a plaintext-only row whose key sorts
 * inside that same offset window, and both passes observe an identical row
 * stream, an identical digest and an identical count — while the new row is read
 * by neither. No number of independent offset-paged HTTP reads closes that,
 * because every pair of reads has a gap a writer can use.
 *
 * So quiescence is ENFORCED, not inferred. Migration 018a installs a barrier that
 * makes writes to the app's tables fail at the database, and this gate:
 *
 *   - refuses to run unless the barrier is engaged;
 *   - re-reads it afterwards and fails if it was released or re-engaged mid-run;
 *   - reads pg_stat's cumulative insert/update/delete counters before and after
 *     and fails on ANY movement — which catches the delete-then-insert above
 *     even though it moves neither the row count nor the digest.
 *
 * The two-pass digest is kept as a second, independent witness. It is defence in
 * depth now, not the proof.
 *
 *   cd server && node scripts/verify-encryption.mjs
 *   cd server && node scripts/verify-encryption.mjs --sample 200   # NOT a gate
 *
 * Read-only: this script never writes, so it never moves the counters it reads.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { decryptField, decryptRegistered } from '../lib/crypto.js';
import { fieldsByTable, fieldKey } from '../lib/encryptedFields.js';
import { blindValueFor, blindValueEquals } from './encrypt-backfill.mjs';

const PAGE = 500;

/** The barrier installed by migration 018a. */
export const BARRIER_TABLE = 'encryption_cutover';
export const COUNTERS_RPC = 'encryption_write_counters';

// Scope comes from the shared registry, NOT from encrypt-backfill.mjs. The gate
// importing its scope from the script it audits meant a column dropped from that
// script's list silently vanished from the gate too — it would then certify a
// drop it had never checked. [audit 2026-08-18, High]
export const JOBS = fieldsByTable();

const pkOf = (job) => job.pk ?? ['id'];
const pkLabel = (job, row) => pkOf(job).map((k) => `${k}=${row[k]}`).join(' ');
const isBlank = (v) => v === null || v === undefined;

/**
 * Length-prefixed framing, so no value can impersonate the delimiters around it.
 *
 * The previous digest joined fields with a `name=value` pattern, which a value
 * containing those bytes could forge: two different rows could hash identically.
 * These are text columns holding arbitrary user input, so that is reachable, not
 * theoretical. "13:Tesco Express" cannot be confused with anything else.
 * [Codex stage-4 RE-VERIFY finding 1, 2026-08-18]
 */
const framed = (v) => {
  const s = String(v);
  return `${Buffer.byteLength(s, 'utf8')}:${s}`;
};
/** Distinguishes SQL NULL from the four-character string "null". */
const nullable = (v) => (isBlank(v) ? 'N;' : `S;${framed(v)}`);

/**
 * Everything about a row that the verification DEPENDS ON, canonically encoded.
 *
 * `user_id` is in here because it is a VALIDATION INPUT, not decoration: the
 * decryption key is HKDF(master, `user:<id>`), so moving a row to another owner
 * makes its ciphertext undecryptable while leaving every other byte identical.
 * Omitting it meant that on any `id`-keyed table an ownership change produced a
 * byte-identical digest, and the second pass's decryption failures — which did
 * notice — were then thrown away by the caller. The gate returned
 * `{"pass":true}` over rows whose ciphertext no longer decrypted at all.
 * [Codex stage-4 RE-VERIFY finding 1, 2026-08-18]
 */
export function digestRow(job, row) {
  const parts = [framed(job.table)];
  for (const k of pkOf(job)) parts.push(framed(k), nullable(row[k]));
  parts.push(framed('user_id'), nullable(row.user_id));
  for (const f of job.fields) {
    parts.push(framed(f.column), nullable(row[f.column]));
    parts.push(framed(f.enc), nullable(row[f.enc]));
  }
  for (const b of job.blind ?? []) {
    const v = row[b.column];
    parts.push(framed(b.column), nullable(isBlank(v) ? null : JSON.stringify(v)));
  }
  return parts.join('');
}

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
 * Is the migration-018a barrier engaged? Fails CLOSED on anything unexpected —
 * a missing table means 018a was never applied, which means writes are not
 * blocked, which means this gate cannot speak for the window it is authorising.
 */
export async function readBarrier(supabase) {
  try {
    const { data, error } = await supabase.from(BARRIER_TABLE).select('engaged, engaged_at');
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { ok: false, reason: `${BARRIER_TABLE} has no row — migration 018a is not applied.` };
    return { ok: true, engaged: row.engaged === true, engagedAt: row.engaged_at ?? null };
  } catch (err) {
    return {
      ok: false,
      reason:
        `could not read ${BARRIER_TABLE} (${err.message}). Migration 018a installs it; ` +
        `without it nothing stops the app writing during the drop.`,
    };
  }
}

/**
 * Cumulative tuple insert/update/delete counters for every public table.
 *
 * This is the witness that catches what a re-read cannot: a delete plus an
 * insert inside an already-scanned offset window leaves the row count and the
 * digest identical, but it cannot leave these numbers identical.
 */
export async function readWriteCounters(supabase) {
  try {
    const { data, error } = await supabase.rpc(COUNTERS_RPC);
    if (error) throw error;
    if (!Array.isArray(data)) return { ok: false, reason: `${COUNTERS_RPC}() returned no rows.` };
    const out = {};
    for (const r of data) out[r.table_name] = Number(r.writes);
    return { ok: true, counters: out };
  } catch (err) {
    return {
      ok: false,
      reason:
        `could not call ${COUNTERS_RPC}() (${err.message}). Migration 018a creates it; ` +
        `without it a write made inside an already-scanned page is undetectable.`,
    };
  }
}

/** Which tables moved between two counter snapshots. */
export function countersMoved(before, after) {
  const moved = [];
  for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[t] !== after[t]) moved.push(t);
  }
  return moved.sort();
}

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
 * Now: ordered offset paging over ALL primary key columns. The offset advances by
 * the number of rows actually RETURNED, so a server-side row cap cannot step over
 * the remainder.
 *
 * `checked === total` remains a useful invariant — it fails the gate on any
 * paging bug, present or future. It is NOT a proof that the scan saw the final
 * state of the table; only the enforced barrier is that. See the header.
 */
async function verifyRows(supabase, job, { limit }) {
  const pk = pkOf(job);
  const cols = [...new Set([
    ...pk, 'user_id',
    ...job.fields.flatMap((f) => [f.column, f.enc]),
    ...(job.blind ?? []).flatMap((b) => [b.from, b.column]),
  ])].join(', ');
  const failures = [];
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
      digest.update(digestRow(job, row));

      for (const f of job.fields) {
        const plain = isBlank(row[f.column]) ? null : String(row[f.column]);
        const cipher = row[f.enc];

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
  const rowCounts = new Map();

  // --- preflight: what exactly are we authorising a destructive migration on?
  const target = describeTarget(env);
  log(`  target database : ${target.host}`);
  log(`  connecting as   : ${target.role}`);
  log(`  encryption key  : ${target.keyFingerprint ? `fingerprint ${target.keyFingerprint}` : 'NOT SET'}`);
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

  // --- the write barrier. Only a real gate run requires it; a --sample run is a
  // diagnostic that cannot authorise anything anyway.
  const gating = sample === null;
  const barrierBefore = await readBarrier(supabase);
  const countersBefore = await readWriteCounters(supabase);

  if (gating) {
    if (!barrierBefore.ok) {
      failures.push(`write barrier: ${barrierBefore.reason}`);
    } else if (!barrierBefore.engaged) {
      failures.push(
        `write barrier is NOT engaged. Nothing is stopping the app or the 03:00 cron writing during ` +
          `this run and the drop that follows it, and no sequence of reads can detect every such write. ` +
          `Engage it: update public.${BARRIER_TABLE} set engaged = true, engaged_at = now();`,
      );
    }
    if (!countersBefore.ok) failures.push(`write counters: ${countersBefore.reason}`);
    log(
      `  write barrier   : ${
        barrierBefore.ok
          ? barrierBefore.engaged
            ? `ENGAGED since ${barrierBefore.engagedAt}`
            : 'NOT ENGAGED'
          : 'UNREADABLE'
      }`,
    );
  } else {
    log('  write barrier   : not checked (--sample runs cannot authorise anything)');
  }
  log('');

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
    rowCounts.set(job.table, r.checked);

    // Fails the gate on any paging bug — the composite-key cursor that stopped
    // after one page, a server row cap, a future refactor. NOT a proof that the
    // rows seen were the final ones; the barrier is what provides that.
    if (gating && r.checked !== total) {
      skipped.push(`${job.table}: ${total} rows exist but only ${r.checked} were verified`);
    }
    log(`  [${r.checked === total || !gating ? 'ok' : 'PROBLEM'}] ${job.table}: ${r.checked}/${total} rows verified`);
  }

  // --- second witness: re-read everything and compare.
  //
  // The second pass DECRYPTS every row again, so its failures are real findings
  // about the database as it stands now. They used to be discarded — only the
  // digest was compared — so a row that had become undecryptable between the two
  // passes was detected and then silently dropped on the floor.
  // [Codex stage-4 RE-VERIFY finding 1, 2026-08-18]
  const drifted = [];
  if (gating) {
    for (const job of jobs) {
      const again = await verifyRows(supabase, job, { limit: null });
      failures.push(...again.failures);
      if (again.digest !== digests.get(job.table)) drifted.push(job.table);
      else if (again.checked !== rowCounts.get(job.table)) drifted.push(job.table);
    }
  }

  // --- the barrier must have held for the WHOLE run, and nothing may have been
  // written to any guarded table while it did.
  if (gating) {
    const barrierAfter = await readBarrier(supabase);
    if (!barrierAfter.ok) {
      failures.push(`write barrier (after): ${barrierAfter.reason}`);
    } else if (!barrierAfter.engaged) {
      failures.push('write barrier was RELEASED while this gate was running — the window is not sealed.');
    } else if (barrierBefore.ok && barrierAfter.engagedAt !== barrierBefore.engagedAt) {
      failures.push(
        'write barrier was released and re-engaged while this gate was running — ' +
          'there was a gap in which anything could have been written.',
      );
    }

    const countersAfter = await readWriteCounters(supabase);
    if (!countersAfter.ok) {
      failures.push(`write counters (after): ${countersAfter.reason}`);
    } else if (countersBefore.ok) {
      const moved = countersMoved(countersBefore.counters, countersAfter.counters);
      if (moved.length) {
        // This is the check that sees a delete-then-insert inside a page the scan
        // had already read — the state Codex reproduced, in which the row count
        // and both digests stay identical while an unencrypted row slips in.
        for (const t of moved) if (!drifted.includes(t)) drifted.push(t);
        failures.push(
          `rows were written during this run despite the barrier: ${moved.join(', ')}. ` +
            `A write that lands inside an already-scanned page moves neither the row count nor the digest, ` +
            `so this counter is the only thing that sees it.`,
        );
      }
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
    log(`FAIL — the database CHANGED while this gate ran: ${[...new Set(drifted)].join(', ')}.`);
    log('The barrier did not hold. Check migration 018a is applied and engaged, pause the app and the');
    log('03:00 recurrences cron, and start again.');
  }
  if (!complete) {
    log(`INCOMPLETE — ran with --sample ${sample}, so ${checked} row(s) were checked and the rest were not.`);
    log('A sampled run is NOT an authorisation for migration 019. Re-run with no --sample.');
  }
  if (pass) {
    log(`PASS — every row verified (${checked}). No plaintext would be lost and no ciphertext is stale.`);
    log(`Target ${target.host}, key fingerprint ${target.keyFingerprint}.`);
    log(`The write barrier was engaged for the whole run (since ${barrierBefore.engagedAt}) and no guarded`);
    log('table was written. Migration 019 may proceed WHILE THE BARRIER REMAINS ENGAGED.');
    log('Re-run this gate immediately before 019 as the final check, and release the barrier only after.');
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
