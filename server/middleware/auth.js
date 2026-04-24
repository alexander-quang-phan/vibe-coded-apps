import { createRemoteJWKSet, jwtVerify } from 'jose';

const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error('[fatal] SUPABASE_URL must be set');
  process.exit(1);
}

const ISSUER = `${SUPABASE_URL}/auth/v1`;
// Supabase publishes its public keys here; `jose` caches + rotates automatically.
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

/**
 * Verifies a Supabase-issued JWT from the Authorization header using the project's
 * asymmetric signing keys (ES256). Success: attaches `req.user = { id, email }`.
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
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
