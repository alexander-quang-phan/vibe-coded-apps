/**
 * The subscription matcher (Phase 17) — pure, no database.
 *
 * The rule under test, from the spec: Trim acts SILENTLY only on an exact match
 * with the note a subscription was marked with. Everything weaker only ever asks.
 * Four review rounds kept finding ways a looser silent rule hid a DIFFERENT
 * subscription and shrank "Per month" with no way back — so most of these tests
 * pin a "silent: no, asking: yes" pair.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prototypeOf,
  nameStrength,
  isSameSubscription,
  isExactNote,
  sameAsDetected,
  looksLikeSameCharge,
  cycleAligned,
  bestTrackedMatch,
  bestPreviewMatch,
} from '../lib/subscriptionMatch.js';

const CAT = 'cat-ent';
const OTHER_CAT = 'cat-food';

/** A tracked recurrence plus its attached charges, as a prototype. */
function proto({
  id = 'r1', description = 'Netflix', amount = 10.99, interval = 'monthly',
  category_id = CAT, cancelled_at = null, cancelledDay = null, linked,
} = {}) {
  const charges = linked ?? [{ date: '2026-10-03', amount, description }];
  return prototypeOf(
    { id, description, amount, interval, category_id, cancelled_at, auto_log: false },
    charges,
    { cancelledDay },
  );
}

const tx = (over = {}) => ({
  type: 'expense', recurrence_id: null, description: 'Netflix', category_id: CAT,
  amount: 10.99, date: '2026-11-03', ...over,
});

// --- prototypeOf ----------------------------------------------------------------

test('prototypeOf derives amount and lastCharged from the LATEST attached charge', () => {
  const p = proto({
    amount: 9.99,
    linked: [
      { date: '2026-08-03', amount: 9.99, description: 'Netflix' },
      { date: '2026-10-03', amount: 12.99, description: 'Netflix' },
      { date: '2026-09-03', amount: 10.99, description: 'Netflix' },
    ],
  });
  assert.equal(p.amount, 12.99, 'a price rise follows the newest charge');
  assert.equal(p.lastCharged, '2026-10-03');
  assert.equal(p.occurrences, 3);
});

test('prototypeOf with zero attached charges falls back to the stored amount and a null date', () => {
  const p = proto({ amount: 7.5, linked: [] });
  assert.equal(p.amount, 7.5);
  assert.equal(p.lastCharged, null);
  assert.equal(p.occurrences, 0);
});

test('ownKey is the marked note only; keys also absorb attached charges', () => {
  const p = proto({
    description: 'Spotify',
    linked: [{ date: '2026-10-01', amount: 11.99, description: 'Spotify Premium' }],
  });
  assert.equal(p.ownKey, 'spotify');
  assert.deepEqual([...p.keys].sort(), ['spotify', 'spotify premium']);
});

// --- nameStrength ------------------------------------------------------------------

test('nameStrength: exact, first word, none', () => {
  const p = proto({ description: 'Apple Music' });
  assert.equal(nameStrength('apple music', p), 'exact');
  assert.equal(nameStrength('apple tv', p), 'firstWord');
  assert.equal(nameStrength('spotify', p), 'none');
  assert.equal(nameStrength(null, p), 'none');
  assert.equal(nameStrength('apple', proto({ description: null, linked: [] })), 'none', 'an unnamed subscription has no name to match');
});

// --- the silent match ----------------------------------------------------------------

test('SILENT: only the marked note, within ±30% — "Apple TV" never silently matches "Apple Music"', () => {
  const p = proto({ description: 'Apple Music', amount: 10.99 });
  assert.equal(isSameSubscription({ key: 'apple music', amount: 12 }, p), true);
  assert.equal(isSameSubscription({ key: 'apple tv', amount: 8.99 }, p), false);
  assert.equal(isSameSubscription({ key: 'apple music', amount: 20 }, p), false, 'outside ±30% is not silently the same');
});

test('CRITICAL: an ABSORBED key is never silent (round 5: "Apple" must not hide iCloud)', () => {
  const p = proto({
    description: 'Apple Music', amount: 10.99,
    linked: [
      { date: '2026-09-03', amount: 10.99, description: 'Apple Music' },
      { date: '2026-10-03', amount: 10.99, description: 'Apple' }, // attached via a weak offer
    ],
  });
  assert.ok(p.keys.has('apple'), 'absorbed for asking');
  assert.equal(isSameSubscription({ key: 'apple', amount: 8.99 }, p), false, 'iCloud noted "Apple" stays visible');
});

test('CRITICAL: nothing without a note is ever a silent match', () => {
  const p = proto({ description: null, amount: 10.99, linked: [{ date: '2026-10-03', amount: 10.99, description: null }] });
  assert.equal(isSameSubscription({ key: null, amount: 10.99 }, p), false);
  assert.equal(sameAsDetected(tx({ description: null }), { merchantKey: 'auto:cat-ent:10:monthly', lastAmount: 10.99 }), false);
});

test('isExactNote matches own or absorbed keys at ANY amount (a price jump stays attachable)', () => {
  const p = proto({ description: 'Disney Plus', amount: 1.99 });
  assert.equal(isExactNote({ key: 'disney plus' }, p), true);
  assert.equal(looksLikeSameCharge(tx({ description: 'Disney Plus', amount: 7.99 }), p), true, '+301% still asks');
});

test('sameAsDetected: the exact two-word key within ±30%, never a synthetic row', () => {
  const det = { merchantKey: 'spotify', lastAmount: 11.99 };
  assert.equal(sameAsDetected(tx({ description: 'Spotify' , amount: 11.99 }), det), true);
  assert.equal(sameAsDetected(tx({ description: 'Spotify Family', amount: 11.99 }), det), false);
  assert.equal(sameAsDetected(tx({ description: 'Spotify', amount: 30 }), det), false);
});

// --- the asking match ---------------------------------------------------------------

test('ASKING: first word within ±30%, boundaries on both sides', () => {
  const p = proto({ description: 'Apple Music', amount: 10 });
  assert.equal(looksLikeSameCharge(tx({ description: 'Apple TV', amount: 13 }), p), true);
  assert.equal(looksLikeSameCharge(tx({ description: 'Apple TV', amount: 7.7 }), p), true);
  assert.equal(looksLikeSameCharge(tx({ description: 'Apple TV', amount: 13.1 }), p), false);
  assert.equal(looksLikeSameCharge(tx({ description: 'Apple TV', amount: 7.6 }), p), false);
});

test('ASKING: a no-note expense matches by category within ±20%', () => {
  const p = proto({ description: 'Netflix', amount: 10 });
  assert.equal(looksLikeSameCharge(tx({ description: null, amount: 12 }), p), true);
  assert.equal(looksLikeSameCharge(tx({ description: null, amount: 12.1 }), p), false);
  assert.equal(looksLikeSameCharge(tx({ description: null, amount: 12, category_id: OTHER_CAT }), p), false);
});

test('a NAMED expense never matches an UNNAMED subscription; different names never match', () => {
  const unnamed = proto({ description: null, linked: [{ date: '2026-10-03', amount: 10.99, description: null }] });
  assert.equal(looksLikeSameCharge(tx({ description: 'Cinema' }), unnamed), false);
  assert.equal(looksLikeSameCharge(tx({ description: 'Spotify' }), proto({ description: 'Netflix' })), false);
});

test('income and already-linked expenses never match', () => {
  const p = proto();
  assert.equal(looksLikeSameCharge(tx({ type: 'income' }), p), false);
  assert.equal(looksLikeSameCharge(tx({ recurrence_id: 'r9' }), p), false);
});

// --- cycleAligned -------------------------------------------------------------------

test('cycleAligned per cadence, including a missed cycle', () => {
  assert.equal(cycleAligned('2026-11-02', '2026-10-03', 'monthly'), true, '30 days');
  assert.equal(cycleAligned('2026-12-04', '2026-10-03', 'monthly'), true, 'a missed month still lines up');
  assert.equal(cycleAligned('2026-10-20', '2026-10-03', 'monthly'), false, 'mid-cycle');
  assert.equal(cycleAligned('2027-10-10', '2026-10-03', 'annual'), true);
  assert.equal(cycleAligned('2026-10-03', '2026-10-03', 'monthly'), false, 'k = 0 is never aligned');
  assert.equal(cycleAligned('2026-11-02', null, 'monthly'), false);
});

test('weekly tolerance is ±1: offsets 3, 4, 10, 11 are NOT aligned', () => {
  const last = '2026-10-01';
  const at = (n) => new Date(Date.parse(`${last}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  for (const n of [3, 4, 10, 11]) assert.equal(cycleAligned(at(n), last, 'weekly'), false, `offset ${n}`);
  for (const n of [6, 7, 8, 14]) assert.equal(cycleAligned(at(n), last, 'weekly'), true, `offset ${n}`);
});

// --- bestTrackedMatch (the Quick Add toast) --------------------------------------------

test('toast: exact beats first word beats no note; closest amount breaks ties', () => {
  const music = proto({ id: 'music', description: 'Apple Music', amount: 10.99 });
  const tv = proto({ id: 'tv', description: 'Apple TV', amount: 8.99 });
  const hit = bestTrackedMatch(tx({ description: 'Apple TV', amount: 8.99, date: '2026-11-02' }), [music, tv]);
  assert.equal(hit.proto.id, 'tv', 'the exact note wins over a closer first-word match');
  assert.equal(hit.kind, 'attach');
});

test('toast: only near an expected date, and never for zero-charge subscriptions', () => {
  const p = proto();
  assert.equal(bestTrackedMatch(tx({ date: '2026-10-20' }), [p]), null, 'mid-cycle stays quiet');
  assert.equal(bestTrackedMatch(tx({ date: '2026-11-02' }), [proto({ linked: [] })]), null);
});

test('toast: a no-note match never prompts for a WEEKLY subscription', () => {
  const weekly = proto({ interval: 'weekly', linked: [{ date: '2026-10-01', amount: 4.5, description: 'Coffee plan' }], description: 'Coffee plan', amount: 4.5 });
  assert.equal(bestTrackedMatch(tx({ description: null, amount: 4.5, date: '2026-10-08' }), [weekly]), null);
  assert.ok(bestTrackedMatch(tx({ description: 'Coffee plan', amount: 4.5, date: '2026-10-08' }), [weekly]));
});

test('toast: a CANCELLED subscription asks only on an exact note, after the cancellation day', () => {
  const cancelled = proto({ cancelled_at: '2026-10-10T09:00:00Z', cancelledDay: '2026-10-10' });
  const back = bestTrackedMatch(tx({ date: '2026-12-20' }), [cancelled]);
  assert.equal(back.kind, 'finalOrBack', 'no cycle check: a resubscription starts on a new day');
  assert.equal(bestTrackedMatch(tx({ date: '2026-10-09' }), [cancelled]), null, 'before the cancellation');
  assert.equal(bestTrackedMatch(tx({ description: 'Netflix Kids', date: '2026-12-20' }), [cancelled]), null, 'first word only');
  assert.equal(bestTrackedMatch(tx({ description: null, date: '2026-12-20' }), [cancelled]), null, 'no note');
});

// --- bestPreviewMatch (the deliberate offer) --------------------------------------------

test('preview: includes zero-charge and cancelled rows, with kind by date and strength', () => {
  const zero = proto({ id: 'z', linked: [] });
  const p1 = bestPreviewMatch(tx({ date: '2026-10-20' }), [zero]);
  assert.equal(p1.proto.id, 'z');
  assert.equal(p1.kind, 'attach');
  assert.equal(p1.strength, 'exact');

  const cancelled = proto({ id: 'c', cancelled_at: '2026-10-10T00:00:00Z', cancelledDay: '2026-10-10' });
  assert.equal(bestPreviewMatch(tx({ date: '2026-09-03' }), [cancelled]).kind, 'attach', 'an old charge of a cancelled service');
  assert.equal(bestPreviewMatch(tx({ date: '2026-11-03' }), [cancelled]).kind, 'finalOrBack');
  assert.equal(bestPreviewMatch(tx({ description: 'Netflix Kids' }), [proto()]).strength, 'weak');
});

test('preview: active beats cancelled within the same strength', () => {
  const active = proto({ id: 'a' });
  const cancelled = proto({ id: 'c', cancelled_at: '2026-10-10T00:00:00Z', cancelledDay: '2026-10-10' });
  assert.equal(bestPreviewMatch(tx(), [cancelled, active]).proto.id, 'a');
});

test('the cancellation day is the user-local day passed in, not the UTC date of the instant', () => {
  // 2026-10-10T02:00Z is still 9 Oct in New York. The ROUTE computes the local day;
  // the matcher must use what it is given and never re-derive it from the instant.
  const p = proto({ cancelled_at: '2026-10-10T02:00:00Z', cancelledDay: '2026-10-09' });
  assert.equal(bestPreviewMatch(tx({ date: '2026-10-10' }), [p]).kind, 'finalOrBack');
});
