#!/usr/bin/env node
/**
 * snapshot-data — a plain-JSON copy of every row in the app's tables.
 *
 * WHY THIS EXISTS. Trim is on Supabase's free tier, which has no automated
 * backups, and this machine has no pg_dump, psql, Supabase CLI or Docker. The
 * Phase 9.5 rollout asks for "take a backup first", and this is the version of
 * that which needs no installs and no database password — it reads through the
 * service-role key that server/.env already holds.
 *
 * WHAT IT IS, HONESTLY:
 *   - It captures DATA. The schema is not in here; the schema is server/migrations/
 *     in git, which is a better copy than a dump anyway.
 *   - It cannot read `auth.users`. That is Supabase Auth's own store and is not
 *     exposed through PostgREST. Accounts are not backed up here — only the
 *     rows the app owns, which are keyed by user_id.
 *   - It is READ ONLY. It issues SELECTs and nothing else.
 *
 * So it is the right safety net for Part A, where every migration is additive
 * and nothing can be destroyed. It is NOT sufficient before migration 019, which
 * drops columns for good: that step needs a real backup that has been proven to
 * restore (SECURITY.md, rollout step 8).
 *
 * Usage:
 *   cd server && node scripts/snapshot-data.mjs
 *   cd server && node scripts/snapshot-data.mjs --out ~/somewhere-else
 *
 * Writes ~/Trim-backups/trim-data-<timestamp>/ by default — OUTSIDE the repo, on
 * purpose. This file contains every user's financial history in plaintext; it
 * must never land in git. Keep it somewhere private and delete it when the
 * rollout is finished.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Every table the app owns. `encryption_cutover` is deliberately absent: it is
// operational state created by 018a, not user data.
const TABLES = [
  'user_stats',
  'categories',
  'transactions',
  'budgets',
  'savings_goals',
  'savings_contributions',
  'ask_messages',
  'recurrences',
  'special_groups',
  'subscription_overrides',
];

const PAGE = 1000;

function parseArgs(argv) {
  const outIdx = argv.indexOf('--out');
  const out = outIdx !== -1 ? argv[outIdx + 1] : null;
  return { out: out ? out.replace(/^~/, homedir()) : path.join(homedir(), 'Trim-backups') };
}

/**
 * Offset paging is fine HERE and nowhere else in this codebase: this script does
 * not write, so there is no mutation shifting rows under the cursor. It still
 * orders explicitly, because an unordered paged read is not reproducible.
 */
async function dumpTable(supabase, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('created_at', { ascending: true, nullsFirst: true })
      .range(from, from + PAGE - 1);
    // Not every table has created_at; fall back to an unordered read rather
    // than failing the whole snapshot over a missing sort column.
    if (error && /created_at/.test(error.message || '')) {
      const retry = await supabase.from(table).select('*').range(from, from + PAGE - 1);
      if (retry.error) throw new Error(`${table}: ${retry.error.message}`);
      rows.push(...retry.data);
      if (retry.data.length < PAGE) break;
      continue;
    }
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[fatal] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in server/.env');
    process.exit(1);
  }
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(out, `trim-data-${stamp}`);
  await mkdir(dir, { recursive: true });

  const counts = {};
  for (const table of TABLES) {
    const rows = await dumpTable(supabase, table);
    counts[table] = rows.length;
    await writeFile(path.join(dir, `${table}.json`), JSON.stringify(rows, null, 2));
    console.log(`  ${String(rows.length).padStart(6)}  ${table}`);
  }

  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        supabaseUrl: url,
        tables: counts,
        totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
        note:
          'Data only. Schema lives in server/migrations/ in git. auth.users is NOT included — ' +
          'Supabase Auth owns it and PostgREST does not expose it. Not a substitute for a real ' +
          'restorable backup before migration 019.',
      },
      null,
      2,
    ),
  );

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n${total} rows across ${TABLES.length} tables ->\n${dir}`);
  console.log('\nThis file holds every user\'s financial history in plaintext. Keep it private.');
}

// pathToFileURL, not `file://${argv[1]}` — this repo's path contains spaces, which
// import.meta.url percent-encodes and a raw template string does not, so the naive
// comparison is false and the script exits silently having done nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[fatal] ${err.message}`);
    process.exit(1);
  });
}
