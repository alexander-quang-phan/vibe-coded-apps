// One home for paging past PostgREST's row cap: subscriptions and trips both read
// every row of a query, and a second copy of this would drift (shape #1).

/**
 * Read EVERY row of a query, past PostgREST's silent max-rows cap.
 *
 * Paged by offset, advancing by the number of rows each page ACTUALLY returned
 * (so it is correct whatever the project's cap is), stopping only on an empty page,
 * and de-duplicated by id (a write landing between pages can shift one row). The
 * builder must order by a unique tie-breaker — date, then id.
 */
const PAGE_SIZE = 500;
const MAX_PAGES = 400; // a runaway backstop far beyond any real account
export async function readAllPages(buildQuery) {
  const out = [];
  const seen = new Set();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await buildQuery().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) return out;
    for (const row of data) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
    offset += data.length;
  }
  throw new Error('readAllPages: page limit reached');
}
