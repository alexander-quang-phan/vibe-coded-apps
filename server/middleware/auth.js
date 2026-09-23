import { createRemoteJWKSet, jwtVerify } from 'jose';

const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error('[fatal] SUPABASE_URL must be set');
  process.exit(1);
}

// Who may hold an account at all. Verifying a token proves only that OUR Supabase
// project issued it — not that the holder is someone Alex invited. Signup is open,
// email confirmation is off (SECURITY.md), and the anon key is public in the client
// bundle by design, so without this list anyone on the internet can self-issue a
// valid token and reach every authenticated route — including /api/ask, which spends
// ANTHROPIC_API_KEY on each turn.
//
// Fail CLOSED at boot, exactly as SUPABASE_URL above does: an unset allowlist must
// never be read as "everyone is welcome". Set ALLOWED_EMAILS in the environment
// BEFORE deploying this file, or the server refuses to start.
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
if (ALLOWED_EMAILS.size === 0) {
  console.error(
    '[fatal] ALLOWED_EMAILS must be set — comma-separated emails permitted to use Trim',
  );
  process.exit(1);
}

const ISSUER = `${SUPABASE_URL}/auth/v1`;
// Supabase publishes its public keys here; `jose` caches + rotates automatically.
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

/**
 * Verifies a Supabase-issued JWT from the Authorization header using the project's
 * asymmetric signing keys (ES256), then checks the holder is on ALLOWED_EMAILS.
 * Success: attaches `req.user = { id, email }`.
 * Failure: 401 generic — don't leak which check failed.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice('Bearer '.length);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: 'authenticated',
    });
    if (!payload.sub) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    // A token can be cryptographically perfect and still belong to a stranger who
    // signed themselves up. 403 rather than 401: the credential is genuine, the
    // account simply isn't invited, so refreshing the token will never help.
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email || !ALLOWED_EMAILS.has(email)) {
      return res.status(403).json({ error: 'This account is not authorised for Trim' });
    }
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
