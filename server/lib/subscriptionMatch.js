/**
 * Phase 17 — "is this the same subscription?", decided in ONE place.
 *
 * Spec: docs/superpowers/specs/2026-10-13-subscription-marking-design.md
 *
 * THE RULE: Trim acts SILENTLY only on an exact match with the note a subscription
 * was MARKED with (`ownKey`). Anything weaker — a first-word resemblance, a note
 * absorbed from an attached charge, or no note at all — is only ever used where Alex
 * is ASKED (the Quick Add toast, the "Add to …?" offer).
 *
 * Why so strict: four review rounds kept finding ways a looser silent rule would
 * hide a DIFFERENT subscription — two £10.99 no-note services billed days apart
 * cannot be told apart from data — and hiding one silently shrinks "Per month"
 * with no way back. Listing something twice is visible and fixable; hiding is not.
 *
 * PURE. No database, and in particular no lib/userZone.js: that imports
 * lib/supabase.js, which exits without SUPABASE_URL and would kill devMock. Callers
 * pass the user-local cancellation day in on the prototype.
 */
import { normaliseMerchant } from './merchant.js';
import { CADENCE_DAYS } from './recurrences.js';

/** How close to an expected charge date a toast may fire, per cadence. */
export const TOLERANCE_DAYS = Object.freeze({ weekly: 1, monthly: 5, annual: 21 });
/** How many whole cycles away a charge may still line up (a missed month is fine). */
export const MAX_CYCLES = Object.freeze({ weekly: 4, monthly: 12, annual: 3 });

const NAME_AMOUNT_TOLERANCE = 0.30;   // a price rise is still the same service
const NO_NOTE_AMOUNT_TOLERANCE = 0.20; // asking only — a person confirms it

const firstWord = (key) => key.split(' ')[0];

function ratio(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0 && y > 0)) return Infinity;
  return Math.max(x, y) / Math.min(x, y);
}

/** Amounts within `pct` of each other (max/min, symmetric). */
export function within(a, b, pct) {
  return ratio(a, b) <= 1 + pct + 1e-9;
}

/**
 * Is charge `a` later than `b`? Date first, then created_at, then id, so "the
 * latest charge" (whose amount a tracked subscription follows) never flips between
 * two requests when two charges share a date.
 */
export function isLaterCharge(a, b) {
  if (!b) return true;
  if (a.date !== b.date) return a.date > b.date;
  const ac = a.created_at ?? '';
  const bc = b.created_at ?? '';
  if (ac !== bc) return ac > bc;
  return String(a.id ?? '') > String(b.id ?? '');
}

export function daysBetween(laterISO, earlierISO) {
  return Math.round(
    (Date.parse(`${laterISO}T00:00:00Z`) - Date.parse(`${earlierISO}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * A tracked subscription as the matcher sees it.
 *
 * @param rec     decoded recurrence: { id, description, category_id, amount, interval, cancelled_at }
 * @param linked  its decoded attached charges: [{ date, amount, description }]
 * @param opts.cancelledDay  the cancellation as the USER's local day (the caller
 *                converts `cancelled_at` with dayInZone). Falls back to the UTC
 *                date only if a caller forgets — never silently wrong by more than a day.
 */
export function prototypeOf(rec, linked = [], { cancelledDay = null } = {}) {
  const ownKey = normaliseMerchant(rec.description);
  const keys = new Set();
  if (ownKey) keys.add(ownKey);
  let latest = null;
  let firstCharged = null;
  for (const t of linked) {
    const k = normaliseMerchant(t.description);
    if (k) keys.add(k);
    if (isLaterCharge(t, latest)) latest = t;
    if (!firstCharged || t.date < firstCharged) firstCharged = t.date;
  }
  const cancelled = !!rec.cancelled_at;
  return {
    id: rec.id,
    ownKey,
    keys,
    category_id: rec.category_id ?? null,
    amount: latest ? Number(latest.amount) : Number(rec.amount),
    cadence: rec.interval,
    lastCharged: latest ? latest.date : null,
    firstCharged,
    occurrences: linked.length,
    active: !cancelled,
    cancelledDay: cancelled ? (cancelledDay ?? String(rec.cancelled_at).slice(0, 10)) : null,
  };
}

/** 'exact' (in keys, own or absorbed) | 'firstWord' | 'none' (different, or a side has no name). */
export function nameStrength(key, proto) {
  if (!key || proto.keys.size === 0) return 'none';
  if (proto.keys.has(key)) return 'exact';
  const fw = firstWord(key);
  for (const k of proto.keys) if (firstWord(k) === fw) return 'firstWord';
  return 'none';
}

/**
 * THE ONLY SILENT MATCH. `item` = { key, amount } (an expense, or a detected row
 * whose synthetic `auto:` key the caller has already turned into null). Used to
 * hide a detected row behind a tracked one.
 */
export function isSameSubscription(item, proto) {
  return !!item.key && !!proto.ownKey && item.key === proto.ownKey
    && within(item.amount, proto.amount, NAME_AMOUNT_TOLERANCE);
}

/**
 * Exact note (own or absorbed) at ANY amount. Not silent: it becomes an offer Alex
 * confirms, and it is what `/track` refuses on. A price jump (Disney+ £1.99 → £7.99)
 * must still be recognised, or nothing could ever attach the new charge.
 */
export function isExactNote(item, proto) {
  return !!item.key && proto.keys.has(item.key);
}

/** "Trim already spots this": an expense with the same note as a detected row (not synthetic). */
export function sameAsDetected(expense, detected) {
  const key = normaliseMerchant(expense.description);
  if (!key || !detected.merchantKey || detected.merchantKey.startsWith('auto:')) return false;
  return key === detected.merchantKey
    && within(expense.amount, detected.lastAmount ?? detected.amount, NAME_AMOUNT_TOLERANCE);
}

/** How an expense resembles a subscription, for ranking: 'exact' | 'firstWord' | 'noNote' | null. */
function strengthOf(tx, proto) {
  if (tx.type !== 'expense' || tx.recurrence_id) return null;
  const key = normaliseMerchant(tx.description);
  if (key) {
    const s = nameStrength(key, proto);
    if (s === 'exact') return 'exact';
    if (s === 'firstWord') return within(tx.amount, proto.amount, NAME_AMOUNT_TOLERANCE) ? 'firstWord' : null;
    return null; // different names, or a named expense against an unnamed subscription
  }
  return tx.category_id != null && tx.category_id === proto.category_id
    && within(tx.amount, proto.amount, NO_NOTE_AMOUNT_TOLERANCE)
    ? 'noNote'
    : null;
}

/** ASKING ONLY. Exact note at any amount, first word within ±30%, or no note within ±20% in the same category. */
export function looksLikeSameCharge(tx, proto) {
  return strengthOf(tx, proto) !== null;
}

/** Dated a whole number of cycles (k ≠ 0) from the last charge, within the cadence's tolerance. */
export function cycleAligned(date, lastCharged, cadence) {
  if (!date || !lastCharged) return false;
  const per = CADENCE_DAYS[cadence];
  const tol = TOLERANCE_DAYS[cadence];
  const n = MAX_CYCLES[cadence];
  if (!per) return false;
  const d = daysBetween(date, lastCharged);
  for (let k = 1; k <= n; k += 1) {
    if (Math.abs(d - k * per) <= tol || Math.abs(d + k * per) <= tol) return true;
  }
  return false;
}

const RANK = { exact: 0, firstWord: 1, noNote: 2 };

function pickBest(candidates, tx) {
  candidates.sort((a, b) =>
    RANK[a.strength] - RANK[b.strength]
    || Number(b.proto.active) - Number(a.proto.active)
    || ratio(tx.amount, a.proto.amount) - ratio(tx.amount, b.proto.amount));
  return candidates[0] ?? null;
}

/** For a cancelled subscription: before the cancellation day it's an old charge; after, a final charge or a comeback. */
function cancelledKind(proto, date) {
  return date > proto.cancelledDay ? 'finalOrBack' : 'attach';
}

/**
 * The Quick Add toast: at most one subscription to ask about.
 *  - active, with ≥1 attached charge: asking match AND cycle-aligned; weekly only on a name;
 *  - cancelled: exact note only, dated after the cancellation day, no cycle check;
 *  - zero-charge subscriptions never toast.
 * Returns { proto, kind: 'attach' | 'finalOrBack', strength } or null.
 */
export function bestTrackedMatch(tx, protos) {
  const candidates = [];
  for (const p of protos) {
    const strength = strengthOf(tx, p);
    if (!strength) continue;
    if (p.active) {
      if (p.occurrences === 0) continue;
      if (p.cadence === 'weekly' && strength === 'noNote') continue;
      if (!cycleAligned(tx.date, p.lastCharged, p.cadence)) continue;
      candidates.push({ proto: p, kind: 'attach', strength });
    } else {
      if (strength !== 'exact') continue;
      if (!(tx.date > p.cancelledDay)) continue;
      candidates.push({ proto: p, kind: 'finalOrBack', strength });
    }
  }
  return pickBest(candidates, tx);
}

/**
 * The deliberate "Add to …?" offer in the Edit and Add dialogs: no cycle check,
 * zero-charge and cancelled subscriptions included.
 * Returns { proto, kind: 'attach' | 'finalOrBack', strength: 'exact' | 'weak' } or null.
 */
export function bestPreviewMatch(expense, protos) {
  const candidates = [];
  for (const p of protos) {
    const strength = strengthOf(expense, p);
    if (!strength) continue;
    // A cancelled subscription is offered only on an exact note — the same rule as
    // the toast — so a weak look-alike never invites reactivating a cancelled service.
    if (!p.active && strength !== 'exact') continue;
    candidates.push({ proto: p, kind: p.active ? 'attach' : cancelledKind(p, expense.date), strength });
  }
  const best = pickBest(candidates, expense);
  return best ? { ...best, strength: best.strength === 'exact' ? 'exact' : 'weak' } : null;
}

/** For `/track`'s 409: an exact-note tracked subscription (active or cancelled), at any amount. */
export function exactNoteConflict(expense, protos) {
  const key = normaliseMerchant(expense.description);
  if (!key) return null;
  const hits = protos.filter((p) => isExactNote({ key }, p))
    .map((p) => ({ proto: p, kind: p.active ? 'attach' : cancelledKind(p, expense.date), strength: 'exact' }));
  return pickBest(hits, expense);
}
