// Trim mock API — run the full UI without Supabase or an Anthropic key.
//
//   npm run dev:mock   (from server/)
//
// Serves every /api/* endpoint the client calls from an in-memory dataset,
// reusing the real pure libs (gamification, subscription detection) so the
// numbers behave like production. Auth is a no-op: any Bearer token passes.
// Nothing persists — restart to reset the demo data.
//
// Note: the client's LOGIN screen still talks to real Supabase Auth (that's
// by design — this mock only replaces the data API). Log in with any real
// account; the data you then see comes from here, not the database.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { applyLogEvent, titleForLevel, levelProgress } from '../lib/gamification.js';
import { detectSubscriptions } from '../lib/subscriptions.js';
import { suggestCategoryName } from '../lib/categoryKeywords.js';

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
function seedTx(categoryName, amount, description, dAgo, type = 'expense') {
  transactions.push({
    id: randomUUID(),
    amount,
    type,
    description: description || null,
    date: daysAgoISO(dAgo),
    category_id: cat(categoryName).id,
    is_recurring: false,
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
  const { currency, simpleMode, displayName, monthlyLimit } = req.body ?? {};
  if (currency !== undefined) stats.currency = currency;
  if (simpleMode !== undefined) stats.simple_mode = !!simpleMode;
  if (displayName !== undefined) stats.display_name = displayName || null;
  if (monthlyLimit !== undefined) stats.monthly_limit = monthlyLimit;
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
  const c = { id: randomUUID(), name, icon, color, type, is_default: false, sort_order: 99 };
  categories.push(c);
  res.status(201).json({ category: c });
});

app.patch('/api/categories/:id', (req, res) => {
  const c = catById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
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
  const sorted = [...transactions].sort(
    (a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at),
  );
  res.json({ transactions: sorted.slice(0, limit) });
});

app.post('/api/transactions', (req, res) => {
  const { categoryId, amount, type, description, date } = req.body ?? {};
  const c = catById(categoryId);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  if (c.type !== type) return res.status(400).json({ error: 'Category type does not match transaction type' });
  const tx = {
    id: randomUUID(),
    amount,
    type,
    description: description || null,
    date: date || todayUTC(),
    category_id: categoryId,
    is_recurring: false,
    created_at: new Date().toISOString(),
  };
  transactions.push(tx);
  const { next, delta } = applyLogEvent(stats, todayUTC());
  stats = { ...stats, ...next };
  res.status(201).json({ transaction: tx, delta });
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
  const { categoryId, amount, type, description, date } = req.body ?? {};
  if (categoryId !== undefined) tx.category_id = categoryId;
  if (amount !== undefined) tx.amount = amount;
  if (type !== undefined) tx.type = type;
  if (description !== undefined) tx.description = description || null;
  if (date !== undefined) tx.date = date;
  res.json({ transaction: tx });
});

app.delete('/api/transactions/:id', (req, res) => {
  transactions = transactions.filter((t) => t.id !== req.params.id);
  res.status(204).end();
});

app.get('/api/dashboard', (_req, res) => {
  const { firstISO, nextFirstISO } = monthBounds();
  const monthTx = transactions.filter((t) => t.date >= firstISO && t.date < nextFirstISO);

  let income = 0;
  let expenses = 0;
  const categoryTotals = new Map();
  for (const t of monthTx) {
    const amt = Number(t.amount);
    if (t.type === 'income') income += amt;
    else {
      expenses += amt;
      categoryTotals.set(t.category_id, (categoryTotals.get(t.category_id) ?? 0) + amt);
    }
  }

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
      category: catShape(catById(t.category_id)),
    }));

  res.json({
    month: {
      firstDay: firstISO,
      income: round2(income),
      expenses: round2(expenses),
      balance: round2(income - expenses),
      transactionCount: monthTx.length,
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
  const spendByCat = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || t.date < firstISO || t.date >= nextFirstISO) continue;
    spendByCat.set(t.category_id, (spendByCat.get(t.category_id) ?? 0) + Number(t.amount));
  }
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
    if (ym === thisYm && t.type === 'expense') {
      catTotals.set(t.category_id, (catTotals.get(t.category_id) ?? 0) + amt);
    }
  }
  for (const s of series) {
    s.income = round2(s.income);
    s.expenses = round2(s.expenses);
    s.net = round2(s.income - s.expenses);
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
  res.json({
    series,
    topCategories,
    mom: {
      thisMonth,
      lastMonth,
      deltaPct: lastMonth > 0 ? round2(((thisMonth - lastMonth) / lastMonth) * 100) : null,
    },
  });
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

app.get('/api/subscriptions', (_req, res) => {
  const detected = detectSubscriptions(transactions.filter((t) => t.type === 'expense'));
  const subscriptions = detected.map((d) => {
    const o = subscriptionOverrides.get(d.merchantKey);
    return {
      ...d,
      category: catShape(catById(d.categoryId)),
      status: o?.status ?? 'active',
      displayName: o?.display_name ?? null,
      decidedAt: o?.decided_at ?? null,
    };
  });
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

app.get('/api/projections/month', (_req, res) => {
  const { firstISO, nextFirstISO } = monthBounds();
  const now = new Date();
  const daysElapsed = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const monthTx = transactions.filter((t) => t.type === 'expense' && t.date >= firstISO && t.date < nextFirstISO);
  if (daysElapsed < 3 || monthTx.length === 0) {
    return res.json({ ready: false, daysElapsed, daysInMonth });
  }
  const spendSoFar = monthTx.reduce((s, t) => s + Number(t.amount), 0);
  // Mirror the real route's outlier guard: one dominant charge (rent) counts
  // once instead of exploding the linear extrapolation.
  const largest = monthTx.length > 0 ? Math.max(...monthTx.map((t) => Number(t.amount))) : 0;
  const projectedSpend =
    spendSoFar > 0 && largest / spendSoFar > 0.4
      ? spendSoFar + ((spendSoFar - largest) / daysElapsed) * (daysInMonth - daysElapsed)
      : (spendSoFar / daysElapsed) * daysInMonth;
  const monthlyBudget = budgets.filter((b) => b.period === 'monthly').reduce((s, b) => s + Number(b.amount_limit), 0) || null;
  res.json({
    ready: true,
    projectedSpend: round2(projectedSpend),
    monthlyBudget: monthlyBudget !== null ? round2(monthlyBudget) : null,
    delta: monthlyBudget !== null ? round2(monthlyBudget - projectedSpend) : null,
    spendSoFar: round2(spendSoFar),
    daysElapsed,
    daysInMonth,
    paceLabel: 'tracking calmly',
  });
});

app.post('/api/affordability', (req, res) => {
  const { amount, categoryId } = req.body ?? {};
  const { firstISO, nextFirstISO } = monthBounds();
  const spendByCat = new Map();
  let totalSpent = 0;
  for (const t of transactions) {
    if (t.type !== 'expense' || t.date < firstISO || t.date >= nextFirstISO) continue;
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
  let totalRemaining = null;
  let totalLimit = 0;
  const monthly = budgets.filter((b) => b.period === 'monthly');
  if (monthly.length > 0) {
    totalLimit = monthly.reduce((s, b) => s + Number(b.amount_limit), 0);
    const budgeted = new Set(monthly.map((b) => b.category_id));
    const budgetedSpend = [...spendByCat.entries()]
      .filter(([id]) => budgeted.has(id))
      .reduce((s, [, v]) => s + v, 0);
    totalRemaining = round2(totalLimit - budgetedSpend - amount);
  }
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
  res.json({ categoryRemaining, totalRemaining, goalImpactDays, goal, verdict });
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
