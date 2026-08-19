// Task 6.12a — nightly executor for manually-marked recurring transactions.
// Invoked by routes/cron.js (POST/GET /api/cron/recurrences), which Vercel
// Cron hits once a day. This is the one place in the codebase that
// legitimately operates across every user's rows via the service-role
// client — see the comment on that route for why that's a deliberate
// exception to "scope every query by req.user.id", not an oversight.
import { supabase } from './supabase.js';
import { advanceToFuture, dueRecurrences, utcDayOfMonth } from './recurrences.js';
import { selectFor, decodeRows, encodeWrite } from './encryptionCodec.js';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const RECURRENCE_COLUMNS =
  'id, user_id, category_id, type, amount, description, interval, next_run_at, last_run_at, cancelled_at, created_at';

/**
 * Claim one due recurrence and insert its transaction. Claim-first order:
 * the optimistic UPDATE (`next_run_at = <the value we read>`) runs BEFORE
 * the transaction insert. That's the safer of the two orders the brief
 * allows — with insert-first, two overlapping invocations (a retried Vercel
 * Cron hit, a manually re-triggered request) could both successfully insert
 * a transaction before either claims, so the loser has to notice it lost and
 * delete its own row; there's a real window where the user would see a
 * duplicate transaction if they queried at exactly the wrong instant.
 * Claim-first instead lets only one process ever reach the insert step for
 * a given occurrence — the UPDATE's `WHERE next_run_at = oldValue` matches
 * at most once, so a second concurrent run's UPDATE affects 0 rows and it
 * skips before ever touching `transactions`.
 *
 * The one gap that flips over from insert-first is: if the insert fails
 * AFTER a successful claim (DB hiccup, FK violation), the schedule has
 * already advanced with nothing to show for it. We close that gap by
 * best-effort reverting the claim so the next run retries the occurrence
 * instead of silently losing it.
 */
// Phase 9.5 Part A. THE most important write in the app to get right: this runs
// unattended at 03:00 and inserts a real transaction. If it wrote plaintext only
// while the deployment is in `dual`, the migration-019 gate would find rows with
// no ciphertext and refuse the cutover — every night, silently, until someone
// looked. At `enc` it would be worse: `description` no longer exists as a column,
// so every nightly run would simply fail.
//
// `row` arrives DECODED from runRecurrences() below, so `row.amount` and
// `row.description` are plaintext here; `encodeWrite` re-encrypts them for the
// transaction, and derives the merchant blind index from the description.
async function processOne(row, today) {
  const anchorDay = utcDayOfMonth(row.created_at);
  const newNextRunAt = advanceToFuture(row.next_run_at, row.interval, anchorDay, today);

  const { data: claimed, error: claimErr } = await supabase
    .from('recurrences')
    .update({ next_run_at: newNextRunAt, last_run_at: today })
    .eq('id', row.id)
    .eq('next_run_at', row.next_run_at)
    .is('cancelled_at', null)
    .select('id')
    .maybeSingle();

  if (claimErr) return { outcome: 'error', error: claimErr };
  if (!claimed) return { outcome: 'skipped' }; // another run already claimed this row

  // Cron-created transactions award NO XP and do NOT extend the streak
  // (Alex's decision, 2026-07-18 — same rule as bank sync). Do NOT call
  // applyLogEvent here. If a future session "fixes" this, it breaks the
  // whole point of the streak: it measures the daily habit of logging by
  // hand, and auto-created rent at 3am would make that meaningless.
  const { error: txErr } = await supabase.from('transactions').insert(
    encodeWrite('transactions', row.user_id, {
      user_id: row.user_id,
      category_id: row.category_id,
      amount: row.amount,
      type: row.type,
      description: row.description,
      date: today,
      is_recurring: true,
      recurrence_id: row.id,
    }),
  );

  if (txErr) {
    // Insert failed after we'd already claimed — best-effort revert so this
    // occurrence isn't silently lost; the next cron run will pick it back up.
    await supabase
      .from('recurrences')
      .update({ next_run_at: row.next_run_at, last_run_at: row.last_run_at ?? null })
      .eq('id', row.id)
      .eq('next_run_at', newNextRunAt);
    return { outcome: 'error', error: txErr };
  }

  return { outcome: 'created' };
}

/**
 * Run the nightly sweep. Returns `{ created, skipped, errors }`. Logs
 * per-user counts only — never amounts or descriptions.
 */
export async function runRecurrences() {
  const today = todayISO();

  const { data: rows, error } = await supabase
    .from('recurrences')
    .select(selectFor('recurrences', RECURRENCE_COLUMNS))
    .is('cancelled_at', null)
    .lte('next_run_at', today);
  if (error) throw error;

  // Decode before anything reads amount/description. Each row carries its own
  // user_id, which is what decodeRows needs to derive the per-user key — this
  // sweep is across ALL users, not one request.
  const due = dueRecurrences(decodeRows('recurrences', null, rows ?? []), today);

  let created = 0;
  let skipped = 0;
  let errors = 0;
  const perUser = new Map();

  for (const row of due) {
    const result = await processOne(row, today);
    const bucket = perUser.get(row.user_id) ?? { created: 0, skipped: 0, errors: 0 };
    if (result.outcome === 'created') {
      created += 1;
      bucket.created += 1;
    } else if (result.outcome === 'skipped') {
      skipped += 1;
      bucket.skipped += 1;
    } else {
      errors += 1;
      bucket.errors += 1;
      console.error('[cron:recurrences] error', {
        userId: row.user_id,
        recurrenceId: row.id,
        message: result.error?.message,
      });
    }
    perUser.set(row.user_id, bucket);
  }

  for (const [userId, counts] of perUser) {
    console.log('[cron:recurrences]', { userId, ...counts });
  }

  return { created, skipped, errors };
}
