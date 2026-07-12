import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { requireAuth } from './middleware/auth.js';
import meRouter from './routes/me.js';
import categoriesRouter from './routes/categories.js';
import transactionsRouter from './routes/transactions.js';
import dashboardRouter from './routes/dashboard.js';
import budgetsRouter from './routes/budgets.js';
import analyticsRouter from './routes/analytics.js';
import goalsRouter from './routes/goals.js';
import winsRouter from './routes/wins.js';
import subscriptionsRouter from './routes/subscriptions.js';
import projectionsRouter from './routes/projections.js';
import affordabilityRouter from './routes/affordability.js';
import askRouter from './routes/ask.js';

const CLIENT_URL = process.env.CLIENT_URL;
if (!CLIENT_URL) {
  console.error('[fatal] CLIENT_URL is not set');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

// Railway sits behind a proxy — needed for express-rate-limit and req.ip.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", CLIENT_URL, 'https://*.supabase.co'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  }),
);

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

app.use(express.json({ limit: '100kb' }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// Stricter limiter to be mounted on /api/auth/* routes once they exist.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});

// Tight limiter for /api/ask — every chat turn costs real money (Claude
// Sonnet + up to 1500 output tokens). Keyed off the authenticated user id
// when available so multiple users behind one NAT don't squeeze each other.
const askLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "You've been chatting a lot — try again in a bit." },
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Protected API — every route below requires a valid Supabase JWT.
app.use('/api/me', requireAuth, meRouter);
app.use('/api/categories', requireAuth, categoriesRouter);
app.use('/api/transactions', requireAuth, transactionsRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/budgets', requireAuth, budgetsRouter);
app.use('/api/analytics', requireAuth, analyticsRouter);
app.use('/api/goals', requireAuth, goalsRouter);
app.use('/api/wins', requireAuth, winsRouter);
app.use('/api/subscriptions', requireAuth, subscriptionsRouter);
app.use('/api/projections', requireAuth, projectionsRouter);
app.use('/api/affordability', requireAuth, affordabilityRouter);
app.use('/api/ask', requireAuth, askLimiter, askRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, _next) => {
  console.error('[error]', { route: req.originalUrl, message: err.message });
  res
    .status(err.status || 500)
    .json({ error: err.publicMessage || 'Internal server error' });
});

// On Vercel the app is imported by api/index.js and invoked per-request;
// locally (and on Railway) we run a real listener.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[trim-server] listening on :${PORT}`);
  });
}

export default app;
