// Covers middleware/auth.js — the ALLOWED_EMAILS gate added 23 Sep 2026, plus the
// surrounding token checks. Before this file, nothing in the suite loaded the real
// middleware: every route suite mounts its router behind a stub that injects
// req.user, so neither the JWT path nor the allowlist had any coverage.
//
// `jose` is mocked so these tests never touch the network. The point is not to
// re-test jose's verification (it is a library) but to pin OUR decisions: which
// principals we admit, and that an unset allowlist can never mean "admit all".
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.ALLOWED_EMAILS = ' Alex@Example.com , friend@example.com ';

let verifyResult = { payload: {} };
mock.module('jose', {
  exports: {
    createRemoteJWKSet: () => ({}),
    jwtVerify: async () => {
      if (verifyResult instanceof Error) throw verifyResult;
      return verifyResult;
    },
  },
});
const { requireAuth } = await import('../middleware/auth.js');

/** Minimal res double: records the status and JSON body a handler produced. */
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

async function callWith(token, payload) {
  verifyResult = payload instanceof Error ? payload : { payload };
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = fakeRes();
  let nexted = false;
  await requireAuth(req, res, () => {
    nexted = true;
  });
  return { req, res, nexted };
}

describe('requireAuth — ALLOWED_EMAILS gate', () => {
  test('admits an email on the allowlist and attaches req.user', async () => {
    const { req, res, nexted } = await callWith('t', {
      sub: 'user-1',
      email: 'friend@example.com',
    });
    assert.equal(nexted, true);
    assert.equal(res.statusCode, null);
    assert.deepEqual(req.user, { id: 'user-1', email: 'friend@example.com' });
  });

  test('matching ignores case and surrounding whitespace on both sides', async () => {
    // The env value above is ' Alex@Example.com , …' and the token says lower-case.
    const { nexted } = await callWith('t', { sub: 'user-1', email: 'alex@example.com' });
    assert.equal(nexted, true);
  });

  test('THE HOLE THIS CLOSES: a self-registered stranger with a valid token gets 403', async () => {
    const { res, nexted } = await callWith('t', {
      sub: 'attacker-1',
      email: 'attacker@evil.example',
    });
    assert.equal(nexted, false, 'a stranger must never reach a route handler');
    assert.equal(res.statusCode, 403);
  });

  test('a token carrying no email claim is refused, not admitted by default', async () => {
    const { res, nexted } = await callWith('t', { sub: 'user-1' });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  });

  test('a non-string email claim cannot slip past the comparison', async () => {
    const { res, nexted } = await callWith('t', { sub: 'user-1', email: { evil: true } });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  });
});

describe('requireAuth — token checks', () => {
  test('missing Authorization header is 401', async () => {
    const { res, nexted } = await callWith(null, { sub: 'user-1', email: 'friend@example.com' });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  test('a token without sub is 401 even when its email is allowed', async () => {
    const { res, nexted } = await callWith('t', { email: 'friend@example.com' });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  test('a verification failure is 401 and never falls through to authenticated', async () => {
    const { res, nexted } = await callWith('t', new Error('bad signature'));
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });
});

describe('requireAuth — fails closed at boot', () => {
  // Run in a child process: the guard calls process.exit(1) at module load, so it
  // cannot be exercised in-process without killing the test run.
  const load = (allowed) => {
    const env = { ...process.env, SUPABASE_URL: 'https://example.supabase.co' };
    if (allowed === undefined) delete env.ALLOWED_EMAILS;
    else env.ALLOWED_EMAILS = allowed;
    try {
      execFileSync(process.execPath, ['-e', "import('./middleware/auth.js')"], {
        env,
        stdio: 'pipe',
      });
      return 0;
    } catch (err) {
      return err.status;
    }
  };

  test('refuses to start when ALLOWED_EMAILS is unset — never "everyone is allowed"', () => {
    assert.equal(load(undefined), 1);
  });

  test('refuses to start when ALLOWED_EMAILS is empty or only separators', () => {
    assert.equal(load(''), 1);
    assert.equal(load(' , , '), 1);
  });

  test('starts when ALLOWED_EMAILS names at least one account', () => {
    assert.equal(load('a@b.com'), 0);
  });
});
