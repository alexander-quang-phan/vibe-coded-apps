// Trim mock API — run the full UI without Supabase or an Anthropic key.
//
//   npm run dev:mock   (from server/)
//
// Serves every /api/* endpoint the client calls from an in-memory dataset,
// reusing the real pure libs (gamification, subscription detection,
// recurrence date math) so the numbers behave like production. Auth is a
// no-op: any Bearer token passes. The one exception is POST/GET
// /api/cron/recurrences (Task 6.12a), which mirrors production's real
// CRON_SECRET gate so its 503/401/200 contract can be verified without a
// real Supabase project — see that route below.
// Nothing persists — restart to reset the demo data.
//
// Note: the client's LOGIN screen still talks to real Supabase Auth (that's
// by design — this mock only replaces the data API). Log in with any real
// account; the data you then see comes from here, not the database.
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { applyLogEvent, titleForLevel, levelProgress } from '../lib/gamification.js';
import { detectSubscriptions } from '../lib/subscriptions.js';
import { suggestCategoryName } from '../lib/categoryKeywords.js';
import { nextRunDate, dueRecurrences, manualMerchantKey } from '../lib/recurrences.js';
import { isSingleEmoji } from '../lib/emoji.js';
import { resolveTotalBudget, buildPace } from '../lib/overallBudget.js';
import { buildRunningAverage } from '../lib/runningAverage.js';
import { convertToBase } from '../lib/fx.js';

const PORT = process.env.PORT || 3001;
const app = express();
app.use(express.json({ limit: '100kb' }));

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const USER = { id: randomUUID(), email: 'demo@trim.app' };

const DEFAULT_CATEGORIES = [
  ['Food', '🍔', '#f97316', 'expense'],
  ['Transport', '🚗', '#3b82f6', 'expense'],
  ['Rent', '🏠', '#8b5cf6', 'expense'],
  ['Bills', '💡', '#ec4899', 'expense'],
  ['Groceries', '🛒', '#84cc16', 'expense'],
  ['Entertainment', '🎬', '#f59e0b', 'expense'],
  ['Shopping', '🛍️', '#06b6d4', 'expense'],
  ['Health', '💊', '#10b981', 'expense'],
  ['Other', '📦', '#64748b', 'expense'],
  ['Salary', '💼', '#22c55e', 'income'],
  ['Freelance', '💻', '#14b8a6', 'income'],
  ['Other Income', '💰', '#eab308', 'income'],
];

const categories = DEFAULT_CATEGORIES.map(([name, icon, color, type], i) => ({
  id: randomUUID(),
  name,
  icon,
  color,
  type,
  is_default: true,
  sort_order: i + 1,
}));
const cat = (name) => categories.find((c) => c.name === name);

const todayUTC = () => new Date().toISOString().slice(0, 10);
function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

let transactions = [];
function seedTx(categoryName, amount, description, dAgo, type = 'expense', isSpecial = false) {
  transactions.push({
    id: randomUUID(),
    amount,
    type,
    description: description || null,
    date: daysAgoISO(dAgo),
    category_id: cat(categoryName).id,
    is_recurring: false,
    is_special: isSpecial,
    recurrence_id: null,
    created_at: new Date(Date.now() - dAgo * 86_400_000).toISOString(),
  });
}

// Salary + rent, monthly
for (const n of [2, 32, 62, 92]) seedTx('Salary', 2450, 'Salary', n, 'income');
for (const n of [1, 31, 61, 91]) seedTx('Rent', 850, 'Rent', n);
// Recurring with descriptions → described subscription detection
for (const n of [5, 35, 65, 95]) seedTx('Entertainment', 12.99, 'Netflix', n);
for (const n of [8, 38, 68, 98]) seedTx('Entertainment', 10.99, 'Spotify', n);
for (const n of [3, 33, 63, 93]) seedTx('Health', 32, 'PureGym membership', n);
// Recurring without description → inferred (synthetic-key) detection
for (const n of [6, 36, 66, 96]) seedTx('Bills', 9.99, '', n);
// Groceries ~2x/week
const shops = ['Tesco', 'Sainsburys', 'Aldi', 'Tesco', 'Lidl'];
for (let n = 0; n < 100; n += 3) {
  if (n % 6 < 3) seedTx('Groceries', 18 + ((n * 7) % 32), shops[n % shops.length], n);
}
// Dining + coffees
const spots = ['Pret', 'Nandos', 'Franco Manca', 'Dishoom', 'Five Guys', ''];
for (let n = 2; n < 100; n += 5) seedTx('Food', 9 + ((n * 3) % 28), spots[n % spots.length], n);
for (const n of [0, 1, 4, 7, 9, 12]) seedTx('Food', 3.4, '', n);
// Transport
for (let n = 1; n < 100; n += 4) seedTx('Transport', 2.8 + (n % 3) * 1.7, n % 8 === 1 ? 'Uber' : 'TfL', n);
// Occasional shopping
for (const [n, amount, description] of [
  [4, 34.5, 'Uniqlo'], [18, 59.99, 'Nike trainers'], [40, 22, 'Waterstones'],
  [55, 89, 'Zara haul'], [77, 45.5, 'Argos'],
]) seedTx('Shopping', amount, description, n);
// Special expenses (Task 9.2) — a couple of flagged one-offs so the pref has
// something to show once the user turns it on.
seedTx('Shopping', 180, "Mum's birthday gift", 10, 'expense', true);
seedTx('Entertainment', 240, 'Weekend trip', 25, 'expense', true);
// Phase 12 — a euro expense, so the "you paid €45.00" line is visible in dev.
transactions.push({
  id: randomUUID(),
  amount: 38.5,
  type: 'expense',
  description: 'Rome walking tour',
  date: daysAgoISO(1),
  category_id: cat('Entertainment').id,
  is_recurring: false,
  is_special: false,
  recurrence_id: null,
  original_amount: 45,
  original_currency: 'EUR',
  fx_rate: 0.85565,
  created_at: new Date(Date.now() - 86_400_000).toISOString(),
});

// Task 6.12a — manually-marked recurrences, seeded with the linked "opt-in"
// transaction the user logged by hand when they created the schedule, so
// /api/subscriptions has a `source: 'manual'` row to show out of the box.
let recurrences = [];
function seedRecurrence({ categoryName, amount, description, interval, dAgo, cancelled = false }) {
  const id = randomUUID();
  const txDate = daysAgoISO(dAgo);
  const createdAt = new Date(Date.now() - dAgo * 86_400_000).toISOString();
  const anchorDay = Number(txDate.slice(8, 10));
  recurrences.push({
    id,
    user_id: USER.id,
    category_id: cat(categoryName).id,
    type: 'expense',
    amount,
    description: description || null,
    interval,
    next_run_at: nextRunDate(txDate, interval, anchorDay),
    last_run_at: null,
    cancelled_at: cancelled ? new Date().toISOString() : null,
    created_at: createdAt,
  });
  transactions.push({
    id: randomUUID(),
    amount,
    type: 'expense',
    description: description || null,
    date: txDate,
    category_id: cat(categoryName).id,
    is_recurring: true,
    is_special: false,
    recurrence_id: id,
    created_at: createdAt,
  });
}
seedRecurrence({ categoryName: 'Bills', amount: 145, description: 'Council Tax', interval: 'monthly', dAgo: 20 });
seedRecurrence({
  categoryName: 'Shopping',
  amount: 60,
  description: 'Storage unit',
  interval: 'monthly',
  dAgo: 200,
  cancelled: true,
});

let budgets = [
  ['Groceries', 260], ['Food', 120], ['Transport', 80],
  ['Entertainment', 40], ['Shopping', 100], ['Rent', 950],
].map(([name, amount_limit], i) => ({
  id: randomUUID(),
  category_id: cat(name).id,
  amount_limit,
  period: 'monthly',
  created_at: new Date(Date.now() - (90 - i) * 86_400_000).toISOString(),
}));

let goals = [
  {
    id: randomUUID(),
    name: 'Japan trip',
    emoji: '🗾',
    target_amount: 1800,
    current_amount: 620,
    target_date: daysAgoISO(-150),
    created_at: new Date(Date.now() - 80 * 86_400_000).toISOString(),
  },
];
let contributions = [
  [120, 80], [100, 52], [150, 24], [250, 6],
].map(([amount, n]) => ({
  id: randomUUID(),
  goal_id: goals[0].id,
  amount,
  note: null,
  created_at: new Date(Date.now() - n * 86_400_000).toISOString(),
}));

let stats = {
  user_id: USER.id,
  current_streak: 6,
  longest_streak: 14,
  shields: 1,
  xp_points: 1240,
  level: 13,
  badges: [],
  currency: 'GBP',
  simple_mode: false,
  monthly_limit: null,
  display_name: 'Alex',
  last_logged_date: todayUTC(),
  special_expenses_enabled: false,
};

let subscriptionOverrides = new Map(); // merchant_key -> { status, display_name, decided_at }
let askMessages = [];

// ---------------------------------------------------------------------------
// Helpers mirroring the real routes
// ---------------------------------------------------------------------------

function monthBounds(d = new Date()) {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const nextFirst = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return {
    firstISO: first.toISOString().slice(0, 10),
    nextFirstISO: nextFirst.toISOString().slice(0, 10),
  };
}

const round2 = (n) => Number(n.toFixed(2));
const catById = (id) => categories.find((c) => c.id === id) ?? null;
const catShape = (c) => (c ? { id: c.id, name: c.name, icon: c.icon, color: c.color } : null);

function statsShape() {
  return {
    currentStreak: stats.current_streak,
    longestStreak: stats.longest_streak,
    shields: stats.shields,
    xpPoints: stats.xp_points,
    level: stats.level,
    title: titleForLevel(stats.level),
    ...levelProgress(stats.xp_points),
  };
}
function prefsShape() {
  return {
    currency: stats.currency,
    simpleMode: stats.simple_mode,
    displayName: stats.display_name,
    monthlyLimit: stats.monthly_limit,
    specialExpensesEnabled: stats.special_expenses_enabled,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ status: 'ok', mock: true }));

app.get('/api/me', (_req, res) => {
  res.json({
    user: USER,
    preferences: prefsShape(),
    stats: { ...statsShape(), badges: stats.badges },
  });
});

app.patch('/api/me', (req, res) => {
  const { currency, simpleMode, displayName, monthlyLimit, specialExpensesEnabled } = req.body ?? {};
  if (currency !== undefined) stats.currency = currency;
  if (simpleMode !== undefined) stats.simple_mode = !!simpleMode;
  if (displayName !== undefined) stats.display_name = displayName || null;
  if (monthlyLimit !== undefined) stats.monthly_limit = monthlyLimit;
  if (specialExpensesEnabled !== undefined) stats.special_expenses_enabled = !!specialExpensesEnabled;
  res.json({ preferences: prefsShape() });
});

app.get('/api/categories', (_req, res) => res.json({ categories }));

app.get('/api/categories/suggest', (req, res) => {
  const desc = String(req.query.desc ?? '').trim();
  if (desc.length < 2) return res.json({ categoryId: null, confidence: 'none', source: 'none' });
  const term = desc.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
  const matches = transactions.filter((t) => (t.description ?? '').toLowerCase().includes(term));
  if (term && matches.length > 0) {
    const counts = new Map();
    for (const m of matches) counts.set(m.category_id, (counts.get(m.category_id) ?? 0) + 1);
    const [categoryId, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return res.json({ categoryId, confidence: count >= 3 ? 'high' : 'medium', source: 'history' });
  }
  const keywordName = suggestCategoryName(desc);
  const c = keywordName ? categories.find((x) => x.name === keywordName && x.type === 'expense') : null;
  if (c) return res.json({ categoryId: c.id, confidence: 'medium', source: 'keyword' });
  res.json({ categoryId: null, confidence: 'none', source: 'none' });
});

app.post('/api/categories', (req, res) => {
  const { name, icon = '📦', color = '#64748b', type } = req.body ?? {};
  // Task 10 A3 — mirror the real route's any-single-emoji rule so the
  // reject-"hack" / accept-👨‍👩‍👧‍👦 contract is provable without Supabase.
  if (!isSingleEmoji(icon)) {
    return res.status(400).json({ error: 'Invalid category', details: { fieldErrors: { icon: ['Pick a single emoji.'] } } });
  }
  const c = { id: randomUUID(), name, icon, color, type, is_default: false, sort_order: 99 };
  categories.push(c);
  res.status(201).json({ category: c });
});

app.patch('/api/categories/:id', (req, res) => {
  const c = catById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  if (req.body?.icon !== undefined && !isSingleEmoji(req.body.icon)) {
    return res.status(400).json({ error: 'Invalid update', details: { fieldErrors: { icon: ['Pick a single emoji.'] } } });
  }
  for (const k of ['name', 'icon', 'color']) if (req.body?.[k] !== undefined) c[k] = req.body[k];
  res.json({ category: c });
});

app.delete('/api/categories/:id', (req, res) => {
  const c = catById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  if (['Other', 'Other Income'].includes(c.name) && c.is_default) {
    return res.status(403).json({ error: 'This category is the reassign safety net.' });
  }
  const referencing = transactions.filter((t) => t.category_id === c.id);
  const reassignTo = req.query.reassign_to;
  if (referencing.length > 0 && !reassignTo) {
    return res.status(409).json({ error: 'Category has transactions', transactionCount: referencing.length });
  }
  if (reassignTo) for (const t of referencing) t.category_id = reassignTo;
  budgets = budgets.filter((b) => b.category_id !== c.id);
  categories.splice(categories.indexOf(c), 1);
  res.status(204).end();
});

app.get('/api/transactions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month ?? '') ? req.query.month : null;
  let list = transactions;
  if (month) {
    const { firstISO, nextFirstISO } = monthBounds(new Date(`${month}-01T00:00:00Z`));
    list = list.filter((t) => t.date >= firstISO && t.date < nextFirstISO);
  }
  const sorted = [...list].sort(
    (a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at),
  );
  res.json({ transactions: sorted.slice(0, limit) });
});

app.post('/api/transactions', (req, res) => {
  const { categoryId, amount, type, description, date, isSpecial, specialGroupId, recurring, foreign, clientToday } = req.body ?? {};
  const c = catById(categoryId);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  if (c.type !== type) return res.status(400).json({ error: 'Category type does not match transaction type' });
  if (isSpecial && type === 'income') {
    return res.status(400).json({ error: 'Only expenses can be special' });
  }
  if (recurring && type === 'income') {
    return res.status(400).json({ error: 'Only expenses can be recurring' });
  }
  if (specialGroupId && !isSpecial) {
    return res.status(400).json({ error: 'Only special expenses can belong to a group' });
  }

  // Phase 12 — mirrors routes/transactions.js: the stored amount is DERIVED
  // from the original and the rate, never trusted from the client.
  let storedAmount = amount;
  let fx = null;
  if (foreign) {
    const oc = String(foreign.originalCurrency).toUpperCase();
    if (oc === stats.currency) {
      storedAmount = convertToBase({ originalAmount: foreign.originalAmount, fxRate: 1, baseCurrency: stats.currency });
    } else {
      storedAmount = convertToBase({ originalAmount: foreign.originalAmount, fxRate: foreign.fxRate, baseCurrency: stats.currency });
      if (storedAmount <= 0) {
        return res.status(400).json({ error: 'That converts to zero in your currency — check the amount and rate' });
      }
      fx = { originalAmount: foreign.originalAmount, originalCurrency: oc, fxRate: foreign.fxRate };
    }
  }

  const txDate = date || todayUTC();
  let recurrence = null;
  if (recurring) {
    const anchorDay = Number(txDate.slice(8, 10));
    const id = randomUUID();
    recurrence = {
      id,
      user_id: USER.id,
      category_id: categoryId,
      type,
      amount,
      description: description || null,
      interval: recurring.interval,
      next_run_at: nextRunDate(txDate, recurring.interval, anchorDay),
      last_run_at: null,
      cancelled_at: null,
      created_at: new Date().toISOString(),
    };
    recurrences.push(recurrence);
  }

  const tx = {
    id: randomUUID(),
    amount: storedAmount,
    type,
    description: description || null,
    date: txDate,
    category_id: categoryId,
    is_recurring: !!recurrence,
    is_special: !!isSpecial,
    special_group_id: specialGroupId ?? null,
    recurrence_id: recurrence?.id ?? null,
    original_amount: fx?.originalAmount ?? null,
    original_currency: fx?.originalCurrency ?? null,
    fx_rate: fx?.fxRate ?? null,
    created_at: new Date().toISOString(),
  };
  transactions.push(tx);
  const { next, delta } = applyLogEvent(stats, clientToday || todayUTC());
  stats = { ...stats, ...next };
  res.status(201).json({
    transaction: tx,
    delta,
    recurrence: recurrence
      ? {
          id: recurrence.id,
          interval: recurrence.interval,
          nextRunAt: recurrence.next_run_at,
          amount: Number(recurrence.amount),
          categoryId: recurrence.category_id,
          merchantKey: manualMerchantKey(recurrence.id),
        }
      : null,
  });
});

app.post('/api/transactions/parse', (req, res) => {
  // Canned parser: pull the first number, guess Food, date = today.
  const text = String(req.body?.text ?? '');
  const m = text.match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return res.status(422).json({ error: 'parse_failed', reason: 'unparseable' });
  const major = Number(m[1].replace(',', '.'));
  res.json({
    parsed: {
      amount: Math.round(major * 100),
      currency: stats.currency,
      categoryId: cat('Food').id,
      description: text.slice(0, 60),
      occurredAt: todayUTC(),
      confidence: 'high',
    },
  });
});

app.patch('/api/transactions/:id', (req, res) => {
  const tx = transactions.find((t) => t.id === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  const { categoryId, amount, type, description, date, isSpecial, specialGroupId, foreign } = req.body ?? {};
  const effectiveType = type !== undefined ? type : tx.type;
  const effectiveSpecial = isSpecial !== undefined ? isSpecial : tx.is_special;
  if (effectiveSpecial && effectiveType === 'income') {
    return res.status(400).json({ error: 'Only expenses can be special' });
  }
  // Un-starring CLEARS the group rather than being rejected — see the real
  // route for why (rejecting it made grouped transactions un-starrable).
  const effectiveGroup =
    isSpecial === false
      ? null
      : specialGroupId !== undefined
        ? specialGroupId
        : tx.special_group_id;
  if (effectiveGroup && !effectiveSpecial) {
    return res.status(400).json({ error: 'Only special expenses can belong to a group' });
  }
  if (categoryId !== undefined) tx.category_id = categoryId;
  if (amount !== undefined) tx.amount = amount;
  // Phase 12b — mirrors routes/transactions.js. Applied AFTER `amount` so the
  // derived figure wins over anything the client sent, same as the real route.
  if (foreign === null) {
    tx.original_amount = null;
    tx.original_currency = null;
    tx.fx_rate = null;
  } else if (foreign) {
    const oc = String(foreign.originalCurrency).toUpperCase();
    if (oc === stats.currency) {
      tx.amount = convertToBase({ originalAmount: foreign.originalAmount, fxRate: 1, baseCurrency: stats.currency });
      tx.original_amount = null;
      tx.original_currency = null;
      tx.fx_rate = null;
    } else {
      const converted = convertToBase({ originalAmount: foreign.originalAmount, fxRate: foreign.fxRate, baseCurrency: stats.currency });
      if (converted <= 0) {
        return res.status(400).json({ error: 'That converts to zero in your currency — check the amount and rate' });
      }
      tx.amount = converted;
      tx.original_amount = foreign.originalAmount;
      tx.original_currency = oc;
      tx.fx_rate = foreign.fxRate;
    }
  }
  if (type !== undefined) tx.type = type;
  if (description !== undefined) tx.description = description || null;
  if (date !== undefined) tx.date = date;
  if (isSpecial !== undefined) tx.is_special = !!isSpecial;
  if (specialGroupId !== undefined) tx.special_group_id = specialGroupId;
  if (isSpecial === false) tx.special_group_id = null;
  res.json({ transaction: tx });
});

app.delete('/api/transactions/:id', (req, res) => {
  transactions = transactions.filter((t) => t.id !== req.params.id);
  res.status(204).end();
});

// Phase 10 B1 — special-expense groups.
let specialGroups = [];

app.get('/api/special-groups', (_req, res) => {
  const byGroup = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || !t.is_special || !t.special_group_id) continue;
    const g = byGroup.get(t.special_group_id) ?? { total: 0, count: 0, dates: [] };
    g.total += Number(t.amount);
    g.count += 1;
    g.dates.push(t.date);
    byGroup.set(t.special_group_id, g);
  }
  res.json({
    groups: specialGroups.map((g) => {
      const agg = byGroup.get(g.id);
      const dates = agg ? [...agg.dates].sort() : [];
      return {
        id: g.id,
        name: g.name,
        archivedAt: g.archived_at,
        total: round2(agg?.total ?? 0),
        count: agg?.count ?? 0,
        firstDate: dates[0] ?? null,
        lastDate: dates.at(-1) ?? null,
      };
    }),
  });
});

app.post('/api/special-groups', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 60) {
    return res.status(400).json({ error: 'Invalid group', details: { fieldErrors: { name: ['1-60 characters.'] } } });
  }
  const g = { id: randomUUID(), name, archived_at: null, created_at: new Date().toISOString() };
  specialGroups.unshift(g);
  res.status(201).json({
    group: { id: g.id, name: g.name, archivedAt: null, total: 0, count: 0, firstDate: null, lastDate: null },
  });
});

app.patch('/api/special-groups/:id', (req, res) => {
  const g = specialGroups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (req.body?.name !== undefined) g.name = String(req.body.name).trim();
  if (req.body?.archived !== undefined) g.archived_at = req.body.archived ? new Date().toISOString() : null;
  res.json({ group: { id: g.id, name: g.name, archivedAt: g.archived_at } });
});

app.delete('/api/special-groups/:id', (req, res) => {
  const before = specialGroups.length;
  specialGroups = specialGroups.filter((x) => x.id !== req.params.id);
  if (specialGroups.length === before) return res.status(404).json({ error: 'Group not found' });
  // `on delete set null` — the spending survives, just ungrouped.
  for (const t of transactions) if (t.special_group_id === req.params.id) t.special_group_id = null;
  res.status(204).end();
});

app.get('/api/dashboard', (_req, res) => {
  const { firstISO, nextFirstISO } = monthBounds();
  const monthTx = transactions.filter((t) => t.date >= firstISO && t.date < nextFirstISO);
  const specialEnabled = !!stats.special_expenses_enabled;

  // Hero totals stay honest cash-flow — every transaction counts.
  let income = 0;
  let expenses = 0;
  for (const t of monthTx) {
    const amt = Number(t.amount);
    if (t.type === 'income') income += amt;
    else expenses += amt;
  }

  // By-category breakdown excludes special expenses while the pref is on.
  const categoryTotals = new Map();
  for (const t of monthTx) {
    if (t.type !== 'expense') continue;
    if (specialEnabled && t.is_special) continue;
    categoryTotals.set(t.category_id, (categoryTotals.get(t.category_id) ?? 0) + Number(t.amount));
  }

  const specialThisMonth = specialEnabled
    ? monthTx.reduce((sum, t) => (t.is_special && t.type !== 'income' ? sum + Number(t.amount) : sum), 0)
    : 0;

  const categoryBreakdown = [...categoryTotals.entries()]
    .map(([categoryId, total]) => {
      const c = catById(categoryId);
      if (!c) return null;
      return {
        categoryId,
        name: c.name,
        icon: c.icon,
        color: c.color,
        total: round2(total),
        percentOfExpenses: expenses > 0 ? total / expenses : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.total - a.total);

  const budgetAlerts = budgets
    .filter((b) => b.period === 'monthly')
    .map((b) => {
      const spent = categoryTotals.get(b.category_id) ?? 0;
      const limit = Number(b.amount_limit);
      const percent = limit > 0 ? spent / limit : 0;
      const c = catById(b.category_id);
      if (percent < 0.75 || !c) return null;
      return {
        budgetId: b.id,
        categoryId: b.category_id,
        name: c.name,
        icon: c.icon,
        color: c.color,
        limit,
        spent: round2(spent),
        percent,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.percent - a.percent);

  const recent = [...transactions]
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      amount: Number(t.amount),
      type: t.type,
      description: t.description,
      date: t.date,
      original_amount: t.original_amount ?? null,
      original_currency: t.original_currency ?? null,
      fx_rate: t.fx_rate ?? null,
      category: catShape(catById(t.category_id)),
    }));

  res.json({
    month: {
      firstDay: firstISO,
      income: round2(income),
      expenses: round2(expenses),
      balance: round2(income - expenses),
      transactionCount: monthTx.length,
      specialThisMonth: round2(specialThisMonth),
    },
    categoryBreakdown,
    budgetAlerts,
    recentTransactions: recent,
    stats: statsShape(),
    preferences: prefsShape(),
  });
});

app.get('/api/budgets', (_req, res) => {
  const { firstISO, nextFirstISO } = monthBounds();
  const specialEnabled = !!stats.special_expenses_enabled;
  const spendByCat = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || t.date < firstISO || t.date >= nextFirstISO) continue;
    if (specialEnabled && t.is_special) continue;
    spendByCat.set(t.category_id, (spendByCat.get(t.category_id) ?? 0) + Number(t.amount));
  }
  // Task 10 A5 — the overall monthly budget card.
  const overallLimit = stats.monthly_limit === null ? null : Number(stats.monthly_limit);
  const totalSpend = [...spendByCat.values()].reduce((s, v) => s + v, 0);
  res.json({
    budgets: budgets.map((b) => {
      const spent = spendByCat.get(b.category_id) ?? 0;
      const limit = Number(b.amount_limit);
      return {
        id: b.id,
        period: b.period,
        limit,
        spent: round2(spent),
        percent: limit > 0 ? spent / limit : 0,
        category: catShape(catById(b.category_id)),
      };
    }),
    overall: {
      limit: overallLimit,
      spent: round2(totalSpend),
      percent: overallLimit && overallLimit > 0 ? totalSpend / overallLimit : 0,
    },
  });
});

app.post('/api/budgets', (req, res) => {
  const { categoryId, amountLimit, period = 'monthly' } = req.body ?? {};
  if (budgets.some((b) => b.category_id === categoryId && b.period === period)) {
    return res.status(409).json({ error: 'Budget already exists for this category' });
  }
  const b = {
    id: randomUUID(),
    category_id: categoryId,
    amount_limit: amountLimit,
    period,
    created_at: new Date().toISOString(),
  };
  budgets.push(b);
  res.status(201).json({
    budget: { id: b.id, period, limit: amountLimit, spent: 0, percent: 0, category: catShape(catById(categoryId)) },
  });
});

app.patch('/api/budgets/:id', (req, res) => {
  const b = budgets.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Budget not found' });
  if (req.body?.amountLimit !== undefined) b.amount_limit = req.body.amountLimit;
  if (req.body?.period !== undefined) b.period = req.body.period;
  res.json({ budget: { id: b.id, period: b.period, limit: Number(b.amount_limit), category: catShape(catById(b.category_id)) } });
});

app.delete('/api/budgets/:id', (req, res) => {
  budgets = budgets.filter((b) => b.id !== req.params.id);
  res.status(204).end();
});

app.get('/api/analytics', (req, res) => {
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
  const specialEnabled = !!stats.special_expenses_enabled;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const ymKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  const series = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    series.push({
      ym: ymKey(d),
      label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      income: 0,
      expenses: 0,
      net: 0,
      special: 0,
    });
  }
  const byYm = new Map(series.map((s) => [s.ym, s]));
  const thisYm = ymKey(now);
  const lastYm = ymKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const catTotals = new Map();

  for (const t of transactions) {
    const ym = t.date.slice(0, 7);
    const bucket = byYm.get(ym);
    if (!bucket) continue;
    const amt = Number(t.amount);
    if (t.type === 'income') bucket.income += amt;
    else bucket.expenses += amt;
    if (t.is_special && specialEnabled && t.type !== 'income') bucket.special += amt;
    if (ym === thisYm && t.type === 'expense') {
      catTotals.set(t.category_id, (catTotals.get(t.category_id) ?? 0) + amt);
    }
  }
  for (const s of series) {
    s.income = round2(s.income);
    s.expenses = round2(s.expenses);
    s.net = round2(s.income - s.expenses);
    s.special = round2(s.special);
  }
  const topCategories = [...catTotals.entries()]
    .map(([categoryId, total]) => {
      const c = catById(categoryId);
      return { categoryId, name: c?.name ?? 'Unknown', icon: c?.icon ?? null, color: c?.color ?? null, total: round2(total) };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const thisMonth = byYm.get(thisYm)?.expenses ?? 0;
  const lastMonth = byYm.get(lastYm)?.expenses ?? 0;

  // Mirrors routes/analytics.js exactly, reusing the same pure lib.
  const windows = [3, 6, 12]
    .map((n) => buildRunningAverage({ series, months: n, currentYm: thisYm }))
    .filter(Boolean);
  const average = windows.length
    ? {
        windows,
        thisMonthSoFar: thisMonth,
        thisMonthSpecial: byYm.get(thisYm)?.special ?? 0,
      }
    : null;

  res.json({
    series,
    average,
    topCategories,
    mom: {
      thisMonth,
      lastMonth,
      deltaPct: lastMonth > 0 ? round2(((thisMonth - lastMonth) / lastMonth) * 100) : null,
    },
  });
});

// Phase 12 — mirrors routes/fx.js. Offline-friendly: a small fixed table rather
// than a live ECB call, so the mock never depends on the network. Unlisted pairs
// return rate: null, which is exactly what the real route does for e.g. VND and
// exercises the client's "type the rate yourself" path.
const MOCK_RATES = { 'EUR->GBP': 0.85565, 'USD->GBP': 0.7912, 'CHF->GBP': 0.9134, 'JPY->GBP': 0.00512 };
app.get('/api/fx', (req, res) => {
  const from = String(req.query.from ?? '').toUpperCase();
  const to = String(req.query.to ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return res.status(400).json({ error: 'Invalid currency pair' });
  }
  if (from === to) return res.json({ rate: 1, date: todayUTC(), source: 'identity', from, to });
  const rate = MOCK_RATES[`${from}->${to}`];
  if (!rate) return res.json({ rate: null, reason: 'unsupported-pair', from, to });
  res.json({ rate, date: todayUTC(), source: 'mock', from, to });
});

app.get('/api/goals', (_req, res) => {
  res.json({
    goals: goals.map((g) => ({
      id: g.id,
      name: g.name,
      emoji: g.emoji,
      targetAmount: Number(g.target_amount),
      currentAmount: Number(g.current_amount),
      targetDate: g.target_date,
      percent: g.target_amount > 0 ? Math.min(g.current_amount / g.target_amount, 1) : 0,
      completed: g.current_amount >= g.target_amount,
      createdAt: g.created_at,
    })),
  });
});

app.post('/api/goals', (req, res) => {
  const { name, emoji, targetAmount, targetDate } = req.body ?? {};
  if (emoji != null && emoji !== '' && !isSingleEmoji(emoji)) {
    return res.status(400).json({ error: 'Invalid goal', details: { fieldErrors: { emoji: ['Pick a single emoji.'] } } });
  }
  const g = {
    id: randomUUID(),
    name,
    emoji: emoji || null,
    target_amount: targetAmount,
    current_amount: 0,
    target_date: targetDate || null,
    created_at: new Date().toISOString(),
  };
  goals.push(g);
  res.status(201).json({
    goal: { id: g.id, name, emoji: g.emoji, targetAmount, currentAmount: 0, targetDate: g.target_date, percent: 0, completed: false, createdAt: g.created_at },
  });
});

app.patch('/api/goals/:id', (req, res) => {
  const g = goals.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Goal not found' });
  if (req.body?.emoji != null && req.body.emoji !== '' && !isSingleEmoji(req.body.emoji)) {
    return res.status(400).json({ error: 'Invalid update', details: { fieldErrors: { emoji: ['Pick a single emoji.'] } } });
  }
  if (req.body?.name !== undefined) g.name = req.body.name;
  if (req.body?.emoji !== undefined) g.emoji = req.body.emoji || null;
  if (req.body?.targetAmount !== undefined) g.target_amount = req.body.targetAmount;
  if (req.body?.targetDate !== undefined) g.target_date = req.body.targetDate || null;
  res.json({
    goal: {
      id: g.id, name: g.name, emoji: g.emoji,
      targetAmount: Number(g.target_amount), currentAmount: Number(g.current_amount),
      targetDate: g.target_date,
      percent: g.target_amount > 0 ? Math.min(g.current_amount / g.target_amount, 1) : 0,
      completed: g.current_amount >= g.target_amount,
      createdAt: g.created_at,
    },
  });
});

app.delete('/api/goals/:id', (req, res) => {
  goals = goals.filter((g) => g.id !== req.params.id);
  res.status(204).end();
});

app.post('/api/goals/:id/contributions', (req, res) => {
  const g = goals.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Goal not found' });
  const amount = Number(req.body?.amount ?? 0);
  const before = g.target_amount > 0 ? g.current_amount / g.target_amount : 0;
  g.current_amount = Number(g.current_amount) + amount;
  const after = g.target_amount > 0 ? g.current_amount / g.target_amount : 0;
  contributions.push({ id: randomUUID(), goal_id: g.id, amount, note: req.body?.note || null, created_at: new Date().toISOString() });
  const crossed = [0.25, 0.5, 0.75, 1.0].filter((t) => before < t && after >= t);
  res.status(201).json({
    goal: {
      id: g.id, name: g.name, emoji: g.emoji,
      targetAmount: Number(g.target_amount), currentAmount: Number(g.current_amount),
      targetDate: g.target_date,
      percent: Math.min(after, 1), completed: after >= 1, createdAt: g.created_at,
    },
    milestone: crossed.at(-1) ?? null,
    justCompleted: before < 1 && after >= 1,
  });
});

app.get('/api/wins', (_req, res) => {
  const fmt = (n) => `£${n.toFixed(2).replace(/\.00$/, '')}`;
  res.json({
    wins: [
      { type: 'under_budget', title: 'Under budget on Entertainment', body: `You're ${fmt(14)} under this week. Nice trim.`, at: new Date(Date.now() - 1 * 86_400_000).toISOString(), icon: '🎬' },
      { type: 'streak', title: '6-day streak', body: 'One more day to a shield.', at: new Date(Date.now() - 1 * 86_400_000).toISOString(), icon: '🔥' },
      { type: 'contribution', title: `${fmt(250)} to Japan trip`, body: '21% → 34%. The yen is trembling.', at: new Date(Date.now() - 6 * 86_400_000).toISOString(), icon: '🗾' },
      { type: 'under_budget', title: 'Under budget on Transport', body: `${fmt(22)} left in the tank this week.`, at: new Date(Date.now() - 8 * 86_400_000).toISOString(), icon: '🚗' },
    ],
  });
});

const CADENCE_DAYS = { monthly: 30, weekly: 7 };

app.get('/api/subscriptions', (_req, res) => {
  const expenseTx = transactions.filter((t) => t.type === 'expense');
  // Manually-marked transactions carry a recurrence_id — exclude them from
  // the auto-detector input so they aren't ALSO counted as a detected sub.
  const autoInput = expenseTx.filter((t) => !t.recurrence_id);
  const byRecurrenceId = new Map();
  for (const t of expenseTx) {
    if (!t.recurrence_id) continue;
    const arr = byRecurrenceId.get(t.recurrence_id) ?? [];
    arr.push(t);
    byRecurrenceId.set(t.recurrence_id, arr);
  }

  const detected = detectSubscriptions(autoInput);
  const autoSubscriptions = detected.map((d) => {
    const o = subscriptionOverrides.get(d.merchantKey);
    return {
      ...d,
      category: catShape(catById(d.categoryId)),
      status: o?.status ?? 'active',
      displayName: o?.display_name ?? null,
      decidedAt: o?.decided_at ?? null,
      source: 'auto',
    };
  });

  const manualSubscriptions = recurrences.map((r) => {
    const linked = byRecurrenceId.get(r.id) ?? [];
    const amount = Number(r.amount);
    const monthlyCost = round2(r.interval === 'monthly' ? amount : amount * (52 / 12));
    const annualCost = round2(r.interval === 'monthly' ? amount * 12 : amount * 52);
    return {
      merchantKey: manualMerchantKey(r.id),
      name: r.description || null,
      inferred: false,
      cadence: r.interval,
      cadenceDays: CADENCE_DAYS[r.interval],
      amount: round2(amount),
      monthlyCost,
      annualCost,
      lastCharged: linked.length ? linked.map((t) => t.date).sort().at(-1) : null,
      nextExpected: r.next_run_at,
      totalPaid: round2(linked.reduce((sum, t) => sum + Number(t.amount), 0)),
      occurrences: linked.length,
      categoryId: r.category_id,
      category: catShape(catById(r.category_id)),
      status: r.cancelled_at ? 'cancelled' : 'active',
      displayName: null,
      decidedAt: r.cancelled_at ?? null,
      source: 'manual',
    };
  });

  const subscriptions = [...autoSubscriptions, ...manualSubscriptions];
  const active = subscriptions.filter((s) => s.status === 'active');
  const cancelled = subscriptions.filter((s) => s.status === 'cancelled');
  const dismissed = subscriptions.filter((s) => s.status === 'dismissed');
  const sum = (arr) => round2(arr.reduce((t, s) => t + s.monthlyCost, 0));
  res.json({
    subscriptions,
    summary: {
      activeCount: active.length,
      cancelledCount: cancelled.length,
      dismissedCount: dismissed.length,
      activeMonthly: sum(active),
      activeAnnual: round2(sum(active) * 12),
      cancelledMonthly: sum(cancelled),
      cancelledAnnual: round2(sum(cancelled) * 12),
    },
  });
});

app.patch('/api/subscriptions/:merchantKey', (req, res) => {
  const merchantKey = decodeURIComponent(req.params.merchantKey);

  if (merchantKey.startsWith('manual:')) {
    const recurrenceId = merchantKey.slice('manual:'.length);
    const r = recurrences.find((x) => x.id === recurrenceId);
    if (!r) return res.status(404).json({ error: 'Recurrence not found' });
    if (req.body?.status === 'dismissed') {
      return res
        .status(400)
        .json({ error: 'Manually-marked recurrences cannot be dismissed — cancel it instead.' });
    }
    if (req.body?.status === 'cancelled') r.cancelled_at = new Date().toISOString();
    else if (req.body?.status === 'active') r.cancelled_at = null;
    if (req.body?.amount !== undefined) r.amount = req.body.amount;
    return res.json({
      recurrence: {
        merchantKey: manualMerchantKey(r.id),
        status: r.cancelled_at ? 'cancelled' : 'active',
        amount: Number(r.amount),
        cancelledAt: r.cancelled_at,
      },
    });
  }

  const existing = subscriptionOverrides.get(merchantKey);
  const merged = {
    status: req.body?.status ?? existing?.status ?? 'active',
    display_name:
      req.body?.displayName !== undefined
        ? (req.body.displayName?.trim() || null)
        : existing?.display_name ?? null,
    decided_at: new Date().toISOString(),
  };
  subscriptionOverrides.set(merchantKey, merged);
  res.json({
    override: {
      merchantKey,
      status: merged.status,
      displayName: merged.display_name,
      decidedAt: merged.decided_at,
    },
  });
});

// Task 6.12a — cron endpoint. Unlike every other mock route (any Bearer
// token passes, no real auth), this one deliberately mirrors production's
// CRON_SECRET-shaped gating: unset -> 503 fail-closed, missing/wrong -> 401,
// correct -> runs. That's the only way to prove the security contract (and
// the idempotency of a double-run) without real Supabase or the live app.
app.all('/api/cron/recurrences', (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'Cron endpoint not configured' });

  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  const bufA = Buffer.from(token || '');
  const bufB = Buffer.from(secret);
  const valid =
    scheme === 'Bearer' && token && bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  if (!valid) return res.status(401).json({ error: 'Unauthorized' });

  const today = todayUTC();
  const due = dueRecurrences(recurrences, today);
  let created = 0;
  const skipped = 0;
  const errors = 0;
  for (const r of due) {
    const anchorDay = Number(String(r.created_at).slice(8, 10));
    let next = nextRunDate(r.next_run_at, r.interval, anchorDay);
    while (next <= today) next = nextRunDate(next, r.interval, anchorDay);
    r.next_run_at = next;
    r.last_run_at = today;
    // Cron-created transactions award NO XP and do NOT extend the streak —
    // stats is intentionally untouched here (Alex's decision, 2026-07-18).
    transactions.push({
      id: randomUUID(),
      amount: r.amount,
      type: r.type,
      description: r.description,
      date: today,
      category_id: r.category_id,
      is_recurring: true,
      is_special: false,
      recurrence_id: r.id,
      created_at: new Date().toISOString(),
    });
    created += 1;
  }
  res.json({ created, skipped, errors });
});

app.get('/api/projections/month', (_req, res) => {
  const { firstISO, nextFirstISO } = monthBounds();
  const specialEnabled = !!stats.special_expenses_enabled;
  const now = new Date();
  const daysElapsed = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const monthTx = transactions.filter(
    (t) => t.type === 'expense' && t.date >= firstISO && t.date < nextFirstISO && !(specialEnabled && t.is_special),
  );
  const spendSoFar = monthTx.reduce((s, t) => s + Number(t.amount), 0);
  // Task 10 A4/A5 — mirror the real route: one shared resolver so pace measures
  // spend on the same basis as the limit, and monthly_limit is no longer gated
  // behind simple_mode.
  const paceSpendByCat = new Map();
  for (const t of monthTx) {
    paceSpendByCat.set(t.category_id, (paceSpendByCat.get(t.category_id) ?? 0) + Number(t.amount));
  }
  const resolved = resolveTotalBudget({
    monthlyLimit: stats.monthly_limit,
    monthlyBudgets: budgets.filter((b) => b.period === 'monthly'),
    spendByCat: paceSpendByCat,
  });
  const monthlyBudget = resolved.limit;
  const pace = buildPace({
    limit: resolved.limit,
    spent: resolved.spent,
    daysElapsed,
    daysInMonth,
  });
  if (daysElapsed < 3 || monthTx.length === 0) {
    return res.json({ ready: false, daysElapsed, daysInMonth, pace });
  }
  // Mirror the real route's outlier guard: one dominant charge (rent) counts
  // once instead of exploding the linear extrapolation.
  const largest = monthTx.length > 0 ? Math.max(...monthTx.map((t) => Number(t.amount))) : 0;
  const projectedSpend =
    spendSoFar > 0 && largest / spendSoFar > 0.4
      ? spendSoFar + ((spendSoFar - largest) / daysElapsed) * (daysInMonth - daysElapsed)
      : (spendSoFar / daysElapsed) * daysInMonth;
  res.json({
    ready: true,
    projectedSpend: round2(projectedSpend),
    monthlyBudget: monthlyBudget !== null ? round2(monthlyBudget) : null,
    delta: monthlyBudget !== null ? round2(monthlyBudget - projectedSpend) : null,
    spendSoFar: round2(spendSoFar),
    daysElapsed,
    daysInMonth,
    paceLabel: 'tracking calmly',
    pace,
  });
});

app.post('/api/affordability', (req, res) => {
  const { amount, categoryId, includeSpecial } = req.body ?? {};
  const { firstISO, nextFirstISO } = monthBounds();
  const specialEnabled = !!stats.special_expenses_enabled;
  const spendByCat = new Map();
  let totalSpent = 0;
  for (const t of transactions) {
    if (t.type !== 'expense' || t.date < firstISO || t.date >= nextFirstISO) continue;
    // Mirrors routes/affordability.js: only skip while the pref is on AND the
    // user is viewing the excl.-special total.
    if (specialEnabled && !includeSpecial && t.is_special) continue;
    const amt = Number(t.amount);
    spendByCat.set(t.category_id, (spendByCat.get(t.category_id) ?? 0) + amt);
    totalSpent += amt;
  }
  let categoryRemaining = null;
  let categoryLimit = 0;
  if (categoryId) {
    const budget = budgets.find((b) => b.category_id === categoryId && b.period === 'monthly');
    if (budget) {
      categoryLimit = Number(budget.amount_limit);
      categoryRemaining = round2(categoryLimit - (spendByCat.get(categoryId) ?? 0) - amount);
    }
  }
  // Task 10 A5 — same shared resolver as projections, so the two agree.
  const resolvedTotal = resolveTotalBudget({
    monthlyLimit: stats.monthly_limit,
    monthlyBudgets: budgets.filter((b) => b.period === 'monthly'),
    spendByCat,
  });
  const totalLimit = resolvedTotal.limit ?? 0;
  const totalRemaining =
    resolvedTotal.limit === null ? null : round2(resolvedTotal.limit - resolvedTotal.spent - amount);
  const totalSource = resolvedTotal.source;
  const open = goals.filter((g) => Number(g.current_amount) < Number(g.target_amount));
  let goal = null;
  let goalImpactDays = null;
  if (open.length > 0) {
    const picked = open.filter((g) => g.target_date).sort((a, b) => a.target_date.localeCompare(b.target_date))[0] ?? open[0];
    const contributed = contributions.reduce((s, c) => s + Number(c.amount), 0);
    if (contributed > 0) {
      goalImpactDays = Math.max(1, Math.round(amount / (contributed / 90)));
      goal = { id: picked.id, name: picked.name, emoji: picked.emoji };
    }
  }
  const signals = [];
  if (categoryRemaining !== null && categoryLimit > 0) signals.push({ remaining: categoryRemaining, limit: categoryLimit });
  if (totalRemaining !== null && totalLimit > 0) signals.push({ remaining: totalRemaining, limit: totalLimit });
  const verdict = signals.length === 0
    ? 'Comfortably yes'
    : signals.some((s) => s.remaining < 0)
      ? 'Would push you over'
      : signals.some((s) => s.remaining < s.limit * 0.15)
        ? 'Tight but yes'
        : 'Comfortably yes';
  res.json({ categoryRemaining, totalRemaining, totalSource, goalImpactDays, goal, verdict });
});

app.get('/api/ask/history', (_req, res) => {
  res.json({ messages: askMessages.slice(-50) });
});

app.delete('/api/ask/history', (_req, res) => {
  askMessages = [];
  res.status(204).end();
});

app.post('/api/ask', (req, res) => {
  const message = String(req.body?.message ?? '').slice(0, 2000);
  const userRow = { id: randomUUID(), role: 'user', content: message, created_at: new Date().toISOString() };
  askMessages.push(userRow);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  send({ type: 'user_message', message: userRow });

  const reply =
    "Great question! Looking at your last 90 days: you've spent about £312 on Groceries this month against a £260 budget — a touch over, mostly the big Saturday shops. Food (dining out) is comfortably inside budget with £41 left. If you want somewhere easy to trim, the £12.99 Netflix + £10.99 Spotify pair is £287.76 a year — worth a quick audit on the Subscriptions page. (Demo answer from the mock server.)";
  const words = reply.split(' ');
  let i = 0;
  const timer = setInterval(() => {
    if (i >= words.length) {
      clearInterval(timer);
      const assistantRow = { id: randomUUID(), role: 'assistant', content: reply, created_at: new Date().toISOString() };
      askMessages.push(assistantRow);
      send({ type: 'done', message: assistantRow, usage: { input_tokens: 0, output_tokens: 0 } });
      res.end();
      return;
    }
    send({ type: 'delta', text: (i === 0 ? '' : ' ') + words[i] });
    i += 1;
  }, 24);
  res.on('close', () => clearInterval(timer));
});

app.use((_req, res) => res.status(404).json({ error: 'Not found (mock)' }));

app.listen(PORT, () => {
  console.log(`[trim-mock] in-memory API on :${PORT} — data resets on restart`);
});
