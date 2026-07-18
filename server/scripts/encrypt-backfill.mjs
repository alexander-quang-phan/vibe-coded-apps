#!/usr/bin/env node
/**
 * Phase 9.5 step 2 of 3 — encrypt-backfill.
 *
 * Populates the `_enc` columns added by migration 012 from the existing
 * plaintext columns, using per-user AES-256-GCM (server/lib/crypto.js).
 *
 * Safety properties:
 * - Idempotent: each table is paged with `where <first_enc_col> is null`, so
 *   rows already encrypted are skipped on a re-run. Running it twice in a
 *   row should report 0 rows encrypted the second time.
 * - Verified: after writing each row's `_enc` values, we re-decrypt them
 *   immediately and compare against the original plaintext value read at the
 *   start of the loop. Any mismatch throws and aborts the whole run loudly —
 *   we would rather stop than silently leave unverifiable ciphertext behind.
 * - Does NOT touch plaintext columns. This script only ever writes to the
 *   `_enc` columns; migration 013 (dropping plaintext) is a separate,
 *   explicitly-gated step.
 *
 * Usage:
 *   cd server && node scripts/encrypt-backfill.mjs
 *
 * Requires (server/.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DATA_ENCRYPTION_KEY. Do NOT run this against production until Alex has
 * generated and backed up DATA_ENCRYPTION_KEY (see SECURITY.md) and applied
 * migration 012.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { encryptField, decryptField } from '../lib/crypto.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const JOBS = [
  { table: 'transactions', fields: [['amount', 'amount_enc'], ['description', 'description_enc']] },
  { table: 'budgets', fields: [['amount_limit', 'amount_limit_enc']] },
  { table: 'categories', fields: [['name', 'name_enc']] },
  { table: 'savings_goals', fields: [['name', 'name_enc'], ['target_amount', 'target_amount_enc'], ['current_amount', 'current_amount_enc']] },
  { table: 'savings_contributions', fields: [['amount', 'amount_enc'], ['note', 'note_enc']] },
  { table: 'subscription_overrides', fields: [['display_name', 'display_name_enc']], pk: ['user_id', 'merchant_key'] },
  { table: 'user_stats', fields: [['monthly_limit', 'monthly_limit_enc']], pk: ['user_id'] },
  { table: 'ask_messages', fields: [['content', 'content_enc']] },
];

for (const job of JOBS) {
  const pk = job.pk ?? ['id'];
  const plainCols = job.fields.map(([p]) => p);
  const firstEnc = job.fields[0][1];
  let done = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from(job.table)
      .select([...pk, 'user_id', ...plainCols].filter((v, i, a) => a.indexOf(v) === i).join(', '))
      .is(firstEnc, null)
      .limit(500);
    if (error) throw error;
    if (!rows.length) break;
    for (const row of rows) {
      const patch = {};
      for (const [plain, enc] of job.fields) {
        patch[enc] = row[plain] === null ? null : encryptField(row.user_id, String(row[plain]));
      }
      let q = supabase.from(job.table).update(patch);
      for (const k of pk) q = q.eq(k, row[k]);
      const { error: upErr } = await q;
      if (upErr) throw upErr;
      // verify round-trip immediately
      for (const [plain, enc] of job.fields) {
        if (row[plain] !== null && decryptField(row.user_id, patch[enc]) !== String(row[plain])) {
          throw new Error(`VERIFY FAILED ${job.table} ${JSON.stringify(row)}`);
        }
      }
      done += 1;
    }
  }
  console.log(`${job.table}: ${done} rows encrypted + verified`);
}
console.log('Backfill complete.');
