// The mount-table guard. SECURITY.md states the rule "Never add a route without
// `requireAuth` unless it's a health check", and until this file nothing enforced it:
// every route suite mounts its router behind a stub that injects `req.user`, so a
// router accidentally mounted WITHOUT requireAuth in index.js would still have a
// green test file, a green build, and no warning anywhere before it deployed.
//
// This is deliberately BEHAVIOURAL rather than a walk of Express internals: it boots
// the real app and asks each mount what it does with an unauthenticated request. The
// answer must be 401 (or 403 — the allowlist also refuses) for everything except the
// two documented exceptions.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Boot the real index.js. VERCEL=1 stops it calling app.listen itself; this file
// binds an ephemeral port instead. The values are placeholders — no request in this
// file reaches Supabase or Anthropic, because requireAuth rejects first.
process.env.VERCEL = '1';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-service-role-key';
process.env.ALLOWED_EMAILS = 'allowed@example.com';
process.env.CRON_SECRET = 'placeholder-cron-secret';

const { default: app } = await import('../index.js');

/** Every /api/* prefix mounted in index.js, and whether it may answer unauthenticated. */
const MOUNTS = [
  { path: '/api/me', open: false },
  { path: '/api/categories', open: false },
  { path: '/api/transactions', open: false },
  { path: '/api/dashboard', open: false },
  { path: '/api/budgets', open: false },
  { path: '/api/analytics', open: false },
  { path: '/api/goals', open: false },
  { path: '/api/wins', open: false },
  { path: '/api/subscriptions', open: false },
  { path: '/api/projections', open: false },
  { path: '/api/affordability', open: false },
  { path: '/api/special-groups', open: false },
  { path: '/api/fx', open: false },
  { path: '/api/ask', open: false },
  // The two documented exceptions. Adding to this list must be a deliberate edit.
  { path: '/api/health', open: true },
  { path: '/api/cron', open: true },
];

let server;
let base;

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

async function getNoAuth(path) {
  const res = await fetch(`${base}${path}`, { method: 'GET' });
  return res.status;
}

describe('every /api mount refuses an unauthenticated request', () => {
  for (const { path, open } of MOUNTS.filter((m) => !m.open)) {
    test(`${path} is behind requireAuth`, async () => {
      const status = await getNoAuth(path);
      assert.ok(
        status === 401 || status === 403,
        `${path} answered ${status} without a token — it is NOT behind requireAuth. ` +
          'If this mount is genuinely meant to be public, add it to MOUNTS with open:true ' +
          'and say why in SECURITY.md.',
      );
    });
  }

  test('the route table in this file still matches index.js', async () => {
    // A new mount that nobody added here would otherwise go untested. Compare against
    // Express's own registered layers so the list cannot silently fall behind.
    const registered = new Set();
    for (const layer of app._router.stack) {
      const src = layer.regexp?.source;
      if (!src) continue;
      const m = /^\^\\\/api\\\/([a-z-]+)/.exec(src);
      if (m) registered.add(`/api/${m[1]}`);
    }
    const known = new Set(MOUNTS.map((m) => m.path));
    const unlisted = [...registered].filter((p) => !known.has(p));
    assert.deepEqual(
      unlisted,
      [],
      `index.js mounts ${unlisted.join(', ')} but this test does not check it. ` +
        'Add it to MOUNTS (open:false unless it is genuinely public).',
    );
  });
});

describe('the documented exceptions behave as documented', () => {
  test('/api/health answers without a token and leaks nothing but status+uptime', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['status', 'uptime']);
  });

  test('/api/cron/recurrences refuses an unauthenticated caller', async () => {
    // Guarded by CRON_SECRET rather than a user JWT — but still never open.
    const status = await getNoAuth('/api/cron/recurrences');
    assert.ok(status === 401 || status === 503, `cron answered ${status}`);
  });

  test('/api/cron/recurrences refuses a WRONG secret', async () => {
    const res = await fetch(`${base}/api/cron/recurrences`, {
      headers: { authorization: 'Bearer definitely-not-the-secret' },
    });
    assert.equal(res.status, 401);
  });

  test('an unknown path is a plain 404, not a stack trace', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Not found' });
  });
});
