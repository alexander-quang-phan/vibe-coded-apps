/**
 * Merchant memory's READ path — the production one.
 *
 * WHY THIS FILE EXISTS  [Codex stage-5 RE-VERIFY #3 finding 4, 2026-08-18]
 * ---------------------------------------------------------------------------
 * The previous revision claimed to have fixed two things about this lookup: that
 * candidates are paged rather than truncated at 200, and that matching stays
 * exact above the prefix cap. Both were true only inside a unit test, which
 * looped over a pre-materialised array that already knew `candidates.length`.
 * There was no production helper at all — nothing a route could call, nothing
 * that had to cope with a real paged response. A fix that exists only in its own
 * test is not a fix.
 *
 * It also quietly narrowed the product. Task 6.9 shipped
 * `.ilike('description', '%term%')`: a SUBSTRING match. The prefix index cannot
 * answer that, so the previous revision recorded "infix" and "second-word-only"
 * matching as accepted losses — a decision the spec never made and Alex never
 * agreed to. Typing "esco" stopped finding Tesco.
 *
 * THE SHAPE, and why it is two tiers
 * ---------------------------------------------------------------------------
 *   Tier 1  The blind index answers a PREFIX match in the database (a GIN
 *           containment scan), keyset-paged, each page decrypted and re-tested
 *           exactly. Fast, and it covers what a typeahead does almost always:
 *           the user types the start of a merchant.
 *   Tier 2  If tier 1 found nothing, a bounded scan of the user's most recent
 *           transactions, decrypted, matched with the real `%term%` rule. This is
 *           what restores "esco" -> Tesco and "express" -> Tesco Express.
 *
 * So the contract is the one Task 6.9 shipped, and the index is what keeps the
 * common case cheap rather than what defines the behaviour. The one honest
 * deviation is stated in the constant below: tier 2 looks at recent history, not
 * all of it.
 */
import { decryptRegistered } from './crypto.js';
import { merchantQueryPrefix, merchantMatches, merchantContains } from './merchant.js';
import { blindIndex } from './crypto.js';

/** How many history rows the suggestion is allowed to weigh. Task 6.9's number. */
export const MATCH_LIMIT = 200;

/** Rows per database round trip while paging candidates. */
export const CANDIDATE_PAGE = 200;

/**
 * Hard ceiling on candidates examined, so a user with thousands of rows sharing
 * one capped prefix cannot turn a keystroke into an unbounded scan. Reaching it
 * is reported, never silently swallowed.
 */
export const CANDIDATE_CEILING = 5000;

/**
 * How far back tier 2 looks. THE ONE DEVIATION from the old ILIKE, stated plainly:
 * a mid-word match against a transaction older than this window will not be found,
 * where `%term%` would have found it. Bounding it is what keeps a per-keystroke
 * fallback affordable; 500 rows is well over a year of daily logging.
 */
export const FALLBACK_SCAN_LIMIT = 500;

const decryptDescription = (userId, row) => {
  // During `dual` the plaintext is still there and is the cheaper, safer source.
  if (row.description !== null && row.description !== undefined) return row.description;
  if (!row.description_enc) return null;
  try {
    return decryptRegistered('transactions.description', userId, row.description_enc);
  } catch {
    // A row we cannot read must not poison a suggestion. The gate is what turns
    // an undecryptable row into a loud failure; here it is simply not a match.
    return null;
  }
};

/**
 * Tier 1 — prefix candidates from the blind index, KEYSET-paged.
 *
 * Keyset (`id > lastSeen`) rather than offset: offset paging shifts under
 * concurrent inserts and deletes, which is how a row gets read twice or skipped
 * entirely. A short page does NOT mean the end — PostgREST can cap a response —
 * so the loop continues until a page comes back empty.
 */
export async function prefixMatches(supabase, { userId, typed, limit = MATCH_LIMIT, page = CANDIDATE_PAGE }) {
  const prefix = merchantQueryPrefix(typed);
  if (!prefix) return { matches: [], scanned: 0, truncated: false };

  const want = blindIndex('transactions.merchant_prefix_hmacs', userId, prefix);
  const matches = [];
  let after = null;
  let scanned = 0;

  for (;;) {
    let q = supabase
      .from('transactions')
      .select('id, category_id, description, description_enc')
      .eq('user_id', userId)
      .contains('merchant_prefix_hmacs', [want])
      .order('id', { ascending: true })
      .limit(page);
    if (after !== null) q = q.gt('id', after);

    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned += 1;
      // Above the cap the index returns a SUPERSET, so the exact test is what
      // keeps the answer honest. Below the cap it is a no-op.
      if (merchantMatches(decryptDescription(userId, row), typed)) matches.push(row);
      if (matches.length >= limit) return { matches, scanned, truncated: true };
    }

    after = data[data.length - 1].id;
    if (scanned >= CANDIDATE_CEILING) return { matches, scanned, truncated: true };
  }
  return { matches, scanned, truncated: false };
}

/**
 * Tier 2 — the real `%term%`, over a bounded window of recent history.
 *
 * Only runs when tier 1 found nothing, which is exactly when the user is typing
 * something that is not the start of a merchant they have used.
 */
export async function substringMatches(supabase, { userId, typed, limit = MATCH_LIMIT, scan = FALLBACK_SCAN_LIMIT }) {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, category_id, description, description_enc')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(scan);
  if (error) throw error;
  if (!data || data.length === 0) return { matches: [], scanned: 0, truncated: false };

  const matches = [];
  for (const row of data) {
    if (merchantContains(decryptDescription(userId, row), typed)) matches.push(row);
    if (matches.length >= limit) break;
  }
  return { matches, scanned: data.length, truncated: data.length >= scan };
}

/** Most-voted category over a set of matched rows, with Task 6.9's confidence rule. */
export function voteCategory(matches) {
  if (!matches || matches.length === 0) return { categoryId: null, confidence: 'none', source: 'none' };
  const counts = new Map();
  for (const m of matches) counts.set(m.category_id, (counts.get(m.category_id) ?? 0) + 1);
  const [categoryId, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { categoryId, confidence: count >= 3 ? 'high' : 'medium', source: 'history' };
}

/**
 * The whole read path. Returns exactly what GET /api/categories/suggest returns
 * for the history half of its answer, plus counters the route can log.
 */
export async function suggestFromHistory(supabase, { userId, typed, ...opts }) {
  const desc = String(typed ?? '').trim();
  // The client fires from the second character; the route has always agreed.
  if (desc.length < 2) return { categoryId: null, confidence: 'none', source: 'none', tier: 'none' };
  if (!merchantQueryPrefix(desc)) return { categoryId: null, confidence: 'none', source: 'none', tier: 'none' };

  const tier1 = await prefixMatches(supabase, { userId, typed: desc, ...opts });
  if (tier1.matches.length > 0) {
    return { ...voteCategory(tier1.matches), tier: 'prefix', scanned: tier1.scanned, truncated: tier1.truncated };
  }

  const tier2 = await substringMatches(supabase, { userId, typed: desc, ...opts });
  if (tier2.matches.length > 0) {
    return { ...voteCategory(tier2.matches), tier: 'substring', scanned: tier2.scanned, truncated: tier2.truncated };
  }

  return { categoryId: null, confidence: 'none', source: 'none', tier: 'none', scanned: tier1.scanned + tier2.scanned };
}
