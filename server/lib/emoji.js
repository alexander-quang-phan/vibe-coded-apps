// Phase 10 (A3). Mirror of client/src/lib/emoji.js — keep the two in sync.
//
// Category icons and savings-goal emoji used to be bounded by
// `z.string().trim().max(8)`. `.max()` counts UTF-16 code units, so that rule
// rejected legitimate single emoji — 👨‍👩‍👧‍👦 is 11 units, 🧑🏻‍🤝‍🧑🏿 is 12+ —
// while accepting plain text like "hack" and runs like "🍔🍔🍔🍔", both of
// which then rendered as-is in every chip and row.
//
// Counting GRAPHEME CLUSTERS is the check we actually meant: exactly one
// visible glyph, and that glyph must be pictographic. Node >=20 (see
// package.json engines) always has Intl.Segmenter.

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function graphemeCount(str) {
  if (!str) return 0;
  return [...segmenter.segment(str)].length;
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Two families of real emoji are NOT Extended_Pictographic and would be
// wrongly rejected by that test alone:
//   flags   🇬🇧 — a pair of regional-indicator letters
//   keycaps 1️⃣ — digit/#/* + optional VS16 + U+20E3
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
