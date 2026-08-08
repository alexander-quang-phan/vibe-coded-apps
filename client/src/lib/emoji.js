// Phase 10 (A3). Mirror of server/lib/emoji.js — keep the two in sync.
//
// The old rule was `z.string().trim().min(1).max(8)`, which counts UTF-16 code
// units. That quietly rejected legitimate single emoji (👨‍👩‍👧‍👦 is 11 units)
// while happily accepting "hack" and "🍔🍔🍔🍔". Counting GRAPHEME CLUSTERS
// instead is the check we actually meant: exactly one visible glyph, and that
// glyph has to be pictographic.

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;

export function graphemeCount(str) {
  if (!str) return 0;
  if (segmenter) return [...segmenter.segment(str)].length;
  // Fallback for anything without Intl.Segmenter: count code points, which
  // over-counts ZWJ sequences but never under-counts.
  return [...str].length;
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Flags (🇬🇧, a regional-indicator pair) and keycaps (1️⃣) are real emoji but
// are NOT Extended_Pictographic — they need their own tests.
const REGIONAL_INDICATOR_PAIR = /^\p{RI}\p{RI}$/u;
const KEYCAP = /^[0-9#*]️?⃣$/;

/** Exactly one grapheme, and it renders as a picture rather than text. */
export function isSingleEmoji(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (!s) return false;
  if (graphemeCount(s) !== 1) return false;
  return PICTOGRAPHIC.test(s) || REGIONAL_INDICATOR_PAIR.test(s) || KEYCAP.test(s);
}
