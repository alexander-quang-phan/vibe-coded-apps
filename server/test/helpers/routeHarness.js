/**
 * A real HTTP harness for route tests, and a fake PostgREST to sit behind it.
 *
 * Phase 9.5 Part A needs one thing proved over and over as the sweep moves route
 * by route: **the JSON a route returns is identical at every ENCRYPTION_PHASE.**
 * Asserting that on the codec alone is not enough — the codec can be perfect while
 * a route forgets to decode one query, and that is exactly the mistake that would
 * ship a `[object Object]` or a raw `v2:…` string into the UI.
 *
 * So these tests mount the REAL router on a real Express app and speak HTTP to it.
 * Only the database is fake.
 *
 * Each phase runs in its own test FILE, because `node --test` gives every file its
 * own process and `ENCRYPTION_PHASE` is read once at import. Set it at the top of
 * the file, before any import of the app code.
 */
import express from 'express';

/**
 * Minimal PostgREST double covering what the swept routes use:
 * select / eq / neq / gt / gte / lt / order / limit / range / contains / is / not,
 * plus insert / update / delete and the single / maybeSingle terminators.
 *
 * `tables` is `{ tableName: [row, ...] }` and is mutated by writes, so a test can
 * assert what was actually stored — which is how "did this write the ciphertext
 * column?" gets answered.
 */
export function fakeSupabase(tables = {}) {
  const store = {};
  for (const [t, rows] of Object.entries(tables)) store[t] = rows.map((r) => ({ ...r }));

  const calls = [];

  const client = {
    store,
    calls,
    from(table) {
      store[table] ??= [];
      const q = {
        _table: table,
        _select: null,
        _filters: [],
        _order: null,
        _asc: true,
        _limit: null,
        _op: 'select',
        _payload: null,
        _single: null,
        _conflict: null,

        select(cols) { q._select = cols; return q; },
        eq(c, v) { q._filters.push((r) => r[c] === v); return q; },
        neq(c, v) { q._filters.push((r) => r[c] !== v); return q; },
        gt(c, v) { q._filters.push((r) => r[c] > v); return q; },
        gte(c, v) { q._filters.push((r) => r[c] >= v); return q; },
        lt(c, v) { q._filters.push((r) => r[c] < v); return q; },
        lte(c, v) { q._filters.push((r) => r[c] <= v); return q; },
        is(c, v) { q._filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
        not(c, _op, v) { q._filters.push((r) => (v === null ? r[c] != null : r[c] !== v)); return q; },
        contains(c, v) { q._filters.push((r) => (r[c] ?? []).includes(v[0])); return q; },
        order(c, o) { q._order = c; q._asc = o?.ascending !== false; return q; },
        limit(n) { q._limit = n; return q; },
        range(a, b) { q._limit = b - a + 1; q._offset = a; return q; },
        insert(payload) { q._op = 'insert'; q._payload = payload; return q; },
        upsert(payload, opts) {
          q._op = 'upsert'; q._payload = payload;
          // PostgREST names the conflict columns; the fake matches on them.
          q._conflict = String(opts?.onConflict ?? 'id').split(',').map((c) => c.trim());
          return q;
        },
        update(payload) { q._op = 'update'; q._payload = payload; return q; },
        delete() { q._op = 'delete'; return q; },
        single() { q._single = 'single'; return q; },
        maybeSingle() { q._single = 'maybe'; return q; },

        then(resolve, reject) {
          try {
            calls.push({ table, op: q._op, select: q._select, payload: q._payload });
            const match = (r) => q._filters.every((f) => f(r));
            let rows;

            if (q._op === 'upsert') {
              const list = Array.isArray(q._payload) ? q._payload : [q._payload];
              rows = list.map((incoming) => {
                const hit = store[table].find((r) =>
                  q._conflict.every((c) => r[c] !== undefined && r[c] === incoming[c]));
                if (hit) { Object.assign(hit, incoming); return hit; }
                const added = { id: `gen-${store[table].length + 1}`, ...incoming };
                store[table].push(added);
                return added;
              });
            } else if (q._op === 'insert') {
              const list = Array.isArray(q._payload) ? q._payload : [q._payload];
              const added = list.map((r) => ({ id: `gen-${store[table].length + 1}`, ...r }));
              store[table].push(...added);
              rows = added;
            } else if (q._op === 'update') {
              rows = store[table].filter(match);
              for (const r of rows) Object.assign(r, q._payload);
            } else if (q._op === 'delete') {
              const keep = store[table].filter((r) => !match(r));
              rows = store[table].filter(match);
              store[table] = keep;
            } else {
              rows = store[table].filter(match);
              if (q._order) {
                rows = [...rows].sort((a, b) => {
                  const av = a[q._order]; const bv = b[q._order];
                  const c = av < bv ? -1 : av > bv ? 1 : 0;
                  return q._asc ? c : -c;
                });
              }
              if (q._offset) rows = rows.slice(q._offset);
              if (q._limit != null) rows = rows.slice(0, q._limit);
            }

            // Project only the requested columns, the way PostgREST does — this is
            // what catches a route that forgot to widen its select.
            const cols = q._select && q._select !== '*'
              ? String(q._select).split(',').map((c) => c.trim()).filter(Boolean)
              : null;
            const project = (r) => {
              if (!cols) return { ...r };
              const out = {};
              for (const c of cols) out[c] = r[c] === undefined ? null : r[c];
              return out;
            };
            const projected = rows.map(project);

            if (q._single) {
              if (projected.length === 0) {
                return Promise.resolve(
                  q._single === 'maybe'
                    ? { data: null, error: null }
                    : { data: null, error: { code: 'PGRST116', message: 'no rows' } },
                ).then(resolve, reject);
              }
              return Promise.resolve({ data: projected[0], error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: projected, error: null }).then(resolve, reject);
          } catch (err) {
            return Promise.resolve({ data: null, error: { message: err.message } }).then(resolve, reject);
          }
        },
      };
      return q;
    },
    rpc() { return Promise.resolve({ data: [], error: null }); },
  };
  return client;
}

/** Mount a router behind a stub auth middleware and start it on an ephemeral port. */
export async function serve(router, { userId, mountAt = '/api' } = {}) {
  const app = express();
  app.use(express.json());
  app.use(mountAt, (req, _res, next) => { req.user = { id: userId, email: 'test@example.com' }; next(); }, router);
  // Mirror server/index.js: never leak a raw database message to the client.
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${mountAt}`;

  return {
    base,
    async get(path) {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async send(method, path, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
