// Task 6.12a — machine-invoked cron endpoint. Mounted WITHOUT requireAuth in
// index.js: there is no user JWT here (no browser session made this request),
// so the usual "every route requires a valid Supabase JWT" rule doesn't
// apply. Instead this route guards itself with a shared secret.
//
// This is the one route in the codebase that legitimately reads/writes
// across every user's rows via the service-role client (runRecurrences
// sweeps the whole `recurrences` table). That's a deliberate, documented
// exception to SECURITY.md's "scope every query by req.user.id" rule — a
// nightly batch job has no single user to scope to by design — not a gap a
// future reviewer should "fix".
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { runRecurrences } from '../lib/runRecurrences.js';

const router = Router();

// Vercel Cron fires this once a day; this limiter is a backstop against a
// leaked URL or a retry storm, not the primary defence (the secret is).
export const cronLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on unequal-length buffers, and comparing length
  // first is not a secret-dependent timing leak (the header's length is
  // sent by the caller in plaintext regardless).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function handler(req, res, next) {
  try {
    const secret = process.env.CRON_SECRET;
    // Fail CLOSED: an unset secret must never be treated as "no auth
    // required" — refuse everything rather than fall open.
    if (!secret) {
      return res.status(503).json({ error: 'Cron endpoint not configured' });
    }

    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token || !safeEqual(token, secret)) {
      // Generic 401 — never reveal whether the header was missing,
      // malformed, or just the wrong value.
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const summary = await runRecurrences();
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

// Vercel Cron issues GET; keep POST too so it can be triggered manually/by
// other schedulers without relying on a GET having side effects being okay.
router.get('/recurrences', cronLimiter, handler);
router.post('/recurrences', cronLimiter, handler);

export default router;
