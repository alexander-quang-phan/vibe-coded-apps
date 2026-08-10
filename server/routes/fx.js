import { Router } from 'express';
import { z } from 'zod';

const router = Router();

// Frankfurter serves ECB reference rates: free, no API key, no rate limit worth
// worrying about, and no account to expire. It publishes ~30 currencies, which
// covers everywhere Alex is travelling — but NOT every currency Trim can be
// based in (VND is absent). A pair we cannot quote is a normal outcome here,
// not an error: the client falls back to letting the user type the rate.
const PROVIDER = 'https://api.frankfurter.dev/v1/latest';
const PROVIDER_NAME = 'ECB via Frankfurter';

const querySchema = z.object({
  from: z.string().regex(/^[A-Za-z]{3}$/, 'Expected a 3-letter currency code'),
  to: z.string().regex(/^[A-Za-z]{3}$/, 'Expected a 3-letter currency code'),
});

// ECB publishes once a working day, so a rate is good for the rest of the day.
// An in-process Map is the right size of solution: it costs nothing, survives
// the burst of requests one Quick Add session makes, and a cold start simply
// re-fetches. Deliberately NOT a database table — there is nothing here worth
// persisting or backing up.
const cache = new Map(); // `${from}->${to}` -> { rate, date, fetchedOn }

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/fx?from=EUR&to=GBP
// -> 200 { rate, date, source, from, to }          rate available
// -> 200 { rate: null, reason, from, to }          pair not quotable — type it yourself
router.get('/', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid currency pair', details: parsed.error.flatten() });
    }
    const from = parsed.data.from.toUpperCase();
    const to = parsed.data.to.toUpperCase();

    // Same currency: no provider call, and no chance of a rate that is not 1.
    if (from === to) {
      return res.json({ rate: 1, date: todayUTC(), source: 'identity', from, to });
    }

    const key = `${from}->${to}`;
    const hit = cache.get(key);
    if (hit && hit.fetchedOn === todayUTC()) {
      return res.json({ rate: hit.rate, date: hit.date, source: PROVIDER_NAME, from, to });
    }

    // Never let a slow third party hold a request open — the user is mid-typing.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    let upstream;
    try {
      upstream = await fetch(`${PROVIDER}?base=${from}&symbols=${to}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
    } catch {
      // Timeout, DNS, offline. Not a 500: the client has a manual path.
      return res.json({ rate: null, reason: 'unreachable', from, to });
    } finally {
      clearTimeout(timeout);
    }

    if (upstream.status === 404) {
      return res.json({ rate: null, reason: 'unsupported-pair', from, to });
    }
    if (!upstream.ok) {
      return res.json({ rate: null, reason: 'provider-error', from, to });
    }

    const body = await upstream.json();
    const rate = body?.rates?.[to];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      // A malformed or zero rate must never reach the conversion — it would
      // silently store an amount of 0.
      return res.json({ rate: null, reason: 'unsupported-pair', from, to });
    }

    const date = typeof body.date === 'string' ? body.date : todayUTC();
    cache.set(key, { rate, date, fetchedOn: todayUTC() });
    res.json({ rate, date, source: PROVIDER_NAME, from, to });
  } catch (err) {
    next(err);
  }
});

export default router;
