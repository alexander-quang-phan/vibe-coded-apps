/**
 * The PRODUCTION merchant-memory read path — lib/merchantMemory.js.
 *
 * Codex's stage-5 RE-VERIFY #3 finding 4: the previous revision's "pagination
 * fix" existed only inside a unit test, looping over a pre-materialised array
 * that already knew how many candidates there were. No route could call it and
 * nothing had to survive a real paged response. And the same revision quietly
 * dropped two behaviours Task 6.9 shipped — mid-word ("esco" -> Tesco) and
 * later-word ("express" -> Tesco Express) matching — by recording them as
 * accepted losses that the spec never accepted.
 *
 * These tests drive the real helper through a fake PostgREST that pages, caps
 * pages short, and fails, and they assert the ORIGINAL substring contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const {
  suggestFromHistory, prefixMatches, substringMatches, voteCategory,
  MATCH_LIMIT, CANDIDATE_CEILING,
} = await import('../lib/merchantMemory.js');
const { encryptField, blindIndexMany, blindIndex } = await import('../lib/crypto.js');
const { merchantPrefixes, merchantQueryPrefix } = await import('../lib/merchant.js');

const U = '00000000-0000-4000-8000-000000000001';
const IDX = 'transactions.merchant_prefix_hmacs';
const GROCERIES = 'cat-groceries';
const HEALTH = 'cat-health';

let seq = 0;
/** A stored row as the backfill/routes write it: ciphertext only, no plaintext. */
const row = (description, category_id) => ({
  id: String(seq++).padStart(6, '0'),
  user_id: U,
  category_id,
  description: null, // post-019 shape: the plaintext column is gone
  description_enc: encryptField('transactions.description', U, description),
  merchant_prefix_hmacs: blindIndexMany(IDX, U, merchantPrefixes(description)),
  date: `2026-08-${String((seq % 28) + 1).padStart(2, '0')}`,
});

/**
 * Fake PostgREST supporting exactly what the helper uses: eq, contains, order,
 * limit, gt (keyset), and an optional short-page cap or error.
 */
function fakeDb(rows, { shortPage = null, failOn = null, pageLog = [] } = {}) {
  let calls = 0;
  return {
    pageLog,
    get calls() { return calls; },
    from() {
      const q = {
        _eq: {}, _contains: null, _order: null, _asc: true, _limit: null, _gt: null,
        select() { return q; },
        eq(col, val) { q._eq[col] = val; return q; },
        contains(col, val) { q._contains = { col, val }; return q; },
        order(col, opts) { q._order = col; q._asc = opts?.ascending !== false; return q; },
        limit(n) { q._limit = n; return q; },
        gt(col, val) { q._gt = { col, val }; return q; },
        then(resolve, reject) {
          calls += 1;
          if (failOn && calls === failOn) {
            return Promise.resolve({ data: null, error: { message: 'connection reset' } })
              .then(resolve, reject);
          }
          let out = rows.filter((r) => Object.entries(q._eq).every(([c, v]) => r[c] === v));
          if (q._contains) {
            out = out.filter((r) => (r[q._contains.col] ?? []).includes(q._contains.val[0]));
          }
          if (q._gt) out = out.filter((r) => r[q._gt.col] > q._gt.val);
          out = [...out].sort((a, b) => {
            const av = String(a[q._order] ?? ''); const bv = String(b[q._order] ?? '');
            return q._asc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
          });
          // A server may return FEWER rows than asked for. That must not be read
          // as "end of results" — only an empty page means that.
          const take = shortPage ? Math.min(q._limit ?? out.length, shortPage) : (q._limit ?? out.length);
          const page = out.slice(0, take);
          pageLog.push(page.length);
          return Promise.resolve({ data: page.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

// --- tier 1: prefix candidates, keyset-paged ---------------------------------

test('the typeahead lights the chip from the second character', async () => {
  const rows = [row('Tesco Express 1234', GROCERIES), row('Tesco Metro 22', GROCERIES)];
  for (const typed of ['Te', 'Tes', 'Tesc', 'Tesco']) {
    const r = await suggestFromHistory(fakeDb(rows), { userId: U, typed });
    assert.equal(r.categoryId, GROCERIES, `typing "${typed}"`);
    assert.equal(r.tier, 'prefix');
  }
});

test('a one-character entry never queries', async () => {
  const db = fakeDb([row('Boots 55', HEALTH)]);
  const r = await suggestFromHistory(db, { userId: U, typed: 'B' });
  assert.equal(r.categoryId, null);
  assert.equal(db.calls, 0, 'it must not even reach the database');
});

test('confidence is high only from three or more matches', async () => {
  const three = [row('Boots 1', HEALTH), row('Boots 2', HEALTH), row('Boots 3', HEALTH)];
  assert.equal((await suggestFromHistory(fakeDb(three), { userId: U, typed: 'Boots' })).confidence, 'high');
  const two = [row('Greggs 1', GROCERIES), row('Greggs 2', GROCERIES)];
  assert.equal((await suggestFromHistory(fakeDb(two), { userId: U, typed: 'Greggs' })).confidence, 'medium');
});

test('CRITICAL REGRESSION: true matches survive 200 rows sharing the capped prefix', async () => {
  // Codex's 203-candidate probe, now against the real helper rather than an
  // in-test loop. All 203 share the capped prefix "sainsbur"; the three real ones
  // sort last, so a `.limit(200)` followed by refinement returns nothing.
  const noise = Array.from({ length: 200 }, (_, i) => row(`Sainsburys Superstore ${i}`, HEALTH));
  const truth = [
    row('Sainsburys Local Camden', GROCERIES),
    row('Sainsburys Local Holborn', GROCERIES),
    row('Sainsburys Local Euston', GROCERIES),
  ];
  const db = fakeDb([...noise, ...truth]);
  const r = await suggestFromHistory(db, { userId: U, typed: 'Sainsburys Local' });

  assert.equal(r.categoryId, GROCERIES);
  assert.equal(r.confidence, 'high');
  assert.equal(r.tier, 'prefix');
  assert.ok(db.calls > 1, 'the helper must keep paging past the first page');
});

test('paging is KEYSET, so it advances by the last id seen', async () => {
  const rows = Array.from({ length: 25 }, () => row('Tesco Express', GROCERIES));
  const db = fakeDb(rows);
  const r = await prefixMatches(db, { userId: U, typed: 'Tesco', page: 5 });
  assert.equal(r.matches.length, 25, 'every candidate is seen exactly once');
  assert.equal(new Set(r.matches.map((m) => m.id)).size, 25, 'no row is read twice');
});

test('a SHORT page is not mistaken for the end of the results', async () => {
  // PostgREST can return fewer rows than asked for. Treating that as exhaustion
  // silently drops the rest of the user's history.
  const rows = Array.from({ length: 30 }, () => row('Tesco Express', GROCERIES));
  const db = fakeDb(rows, { shortPage: 7 }); // always returns at most 7
  const r = await prefixMatches(db, { userId: U, typed: 'Tesco', page: 200 });
  assert.equal(r.matches.length, 30, 'paging must continue until a page comes back EMPTY');
});

test('the candidate ceiling bounds the work and says so', async () => {
  // Every row SHARES the capped prefix "tesco ex" and every row then FAILS the
  // exact test — the worst case the ceiling exists for.
  const rows = Array.from({ length: CANDIDATE_CEILING + 50 }, () => row('Tesco Express', GROCERIES));
  const r = await prefixMatches(fakeDb(rows), { userId: U, typed: 'Tesco Expressway', page: 500 });
  assert.equal(r.matches.length, 0);
  assert.ok(r.truncated, 'hitting the ceiling must be reported, not silently swallowed');
  assert.ok(r.scanned >= CANDIDATE_CEILING);
});

test('the match limit stops the scan early', async () => {
  const rows = Array.from({ length: MATCH_LIMIT + 40 }, () => row('Tesco Express', GROCERIES));
  const r = await prefixMatches(fakeDb(rows), { userId: U, typed: 'Tesco', page: 50 });
  assert.equal(r.matches.length, MATCH_LIMIT);
  assert.ok(r.truncated);
});

test('a database error is surfaced, not turned into "no suggestion"', async () => {
  // A silent catch here would make the chip look merely unhelpful while the
  // lookup was actually broken — the exact failure mode a blind index makes
  // undiagnosable once the plaintext is gone.
  const rows = Array.from({ length: 10 }, () => row('Tesco Express', GROCERIES));
  await assert.rejects(
    () => suggestFromHistory(fakeDb(rows, { failOn: 1 }), { userId: U, typed: 'Tesco' }),
    // PostgREST hands back a plain object, and the codebase convention is to
    // rethrow it as-is for the Express error middleware.
    (err) => err.message === 'connection reset',
  );
});

test('an undecryptable row is not a match, and does not break the lookup', async () => {
  const good = [row('Tesco Express', GROCERIES), row('Tesco Express', GROCERIES), row('Tesco Express', GROCERIES)];
  const broken = { ...row('Tesco Express', GROCERIES), description_enc: 'v2:zz:zz:zz' };
  const r = await suggestFromHistory(fakeDb([...good, broken]), { userId: U, typed: 'Tesco' });
  assert.equal(r.categoryId, GROCERIES);
  assert.equal(r.confidence, 'high', 'the three readable rows still vote');
});

test('above the prefix cap the answer stays EXACT, not approximate', async () => {
  const rows = [row('Sainsburys Superstore Kensington', HEALTH)];
  // Shares the capped prefix "sainsbur" but is a different merchant.
  const r = await suggestFromHistory(fakeDb(rows), { userId: U, typed: 'Sainsburys Local' });
  assert.equal(r.categoryId, null, 'the hash narrows; the decrypted text decides');
});

test("one user's history never answers another user's query", async () => {
  const rows = [row('Tesco Express', GROCERIES)];
  const other = '00000000-0000-4000-8000-000000000002';
  const r = await suggestFromHistory(fakeDb(rows), { userId: other, typed: 'Tesco' });
  assert.equal(r.categoryId, null);
});

// --- tier 2: the substring contract Task 6.9 actually shipped ----------------

test('RESTORED: mid-word matching works again — "esco" finds Tesco', async () => {
  // The previous revision recorded this as an accepted loss. `.ilike('%esco%')`
  // matched it, the spec says behaviour is identical, and nobody agreed to drop
  // it. [Codex stage-5 RE-VERIFY #3 finding 4, 2026-08-18]
  const rows = [row('Tesco Express 1234', GROCERIES), row('Tesco Metro 22', GROCERIES)];
  const r = await suggestFromHistory(fakeDb(rows), { userId: U, typed: 'esco' });
  assert.equal(r.categoryId, GROCERIES);
  assert.equal(r.tier, 'substring', 'the index cannot answer this; the bounded scan does');
});

test('RESTORED: later-word matching works again — "Express" finds Tesco Express', async () => {
  const rows = [row('Tesco Express 1234', GROCERIES), row('Tesco Express 9999', GROCERIES)];
  const r = await suggestFromHistory(fakeDb(rows), { userId: U, typed: 'Express' });
  assert.equal(r.categoryId, GROCERIES);
  assert.equal(r.tier, 'substring');
});

test('the substring tier only runs when the index found nothing', async () => {
  const rows = Array.from({ length: 3 }, () => row('Tesco Express', GROCERIES));
  const r = await suggestFromHistory(fakeDb(rows), { userId: U, typed: 'Tesco' });
  assert.equal(r.tier, 'prefix', 'a prefix hit must not pay for the fallback scan');
});

test('the substring tier is bounded, and says when it hit the bound', async () => {
  const rows = Array.from({ length: 40 }, () => row('Tesco Express', GROCERIES));
  const r = await substringMatches(fakeDb(rows), { userId: U, typed: 'esco', scan: 10 });
  assert.ok(r.truncated, 'the recent-history window is a documented deviation, so it must be visible');
  assert.equal(r.scanned, 10);
});

test('an unknown merchant still matches nothing at either tier', async () => {
  const rows = [row('Tesco Express', GROCERIES), row('Boots 55', HEALTH)];
  const r = await suggestFromHistory(fakeDb(rows), { userId: U, typed: 'Greggs' });
  assert.equal(r.categoryId, null);
  assert.equal(r.tier, 'none');
});

test('apostrophe merchants match, which they never did before', async () => {
  const rows = Array.from({ length: 3 }, () => row("Sainsbury's Local", GROCERIES));
  const r = await suggestFromHistory(fakeDb(rows), { userId: U, typed: "Sainsbury's" });
  assert.equal(r.categoryId, GROCERIES);
});

test('blank and punctuation-only entries never query', async () => {
  for (const typed of ['', '  ', '!!!', null, undefined]) {
    const db = fakeDb([row('Tesco Express', GROCERIES)]);
    const r = await suggestFromHistory(db, { userId: U, typed });
    assert.equal(r.categoryId, null, JSON.stringify(typed));
    assert.equal(db.calls, 0, `${JSON.stringify(typed)} must not reach the database`);
  }
});

test('during dual-write the plaintext column is used directly when present', async () => {
  // Cheaper and safer than decrypting, and it is what makes this helper usable
  // before 019 has run.
  const dual = { ...row('Tesco Express', GROCERIES), description: 'Tesco Express' };
  const rows = [dual, { ...row('Tesco Express', GROCERIES), description: 'Tesco Express' }];
  const r = await suggestFromHistory(fakeDb(rows), { userId: U, typed: 'Tesco' });
  assert.equal(r.categoryId, GROCERIES);
});

test('voteCategory picks the most-voted category, not the first seen', () => {
  const r = voteCategory([
    { category_id: GROCERIES }, { category_id: HEALTH },
    { category_id: HEALTH }, { category_id: HEALTH },
  ]);
  assert.equal(r.categoryId, HEALTH);
  assert.equal(r.confidence, 'high');
});

test('the read path hashes the same capped prefix the write path stores', () => {
  // The invariant whose absence caused the 24/25-character dead zone.
  const stored = merchantPrefixes('Sainsburys Superstore Kensington');
  const queried = merchantQueryPrefix('Sainsburys Superstore Kensington and more');
  assert.equal(queried, stored[stored.length - 1]);
  assert.ok(blindIndex(IDX, U, queried));
});
