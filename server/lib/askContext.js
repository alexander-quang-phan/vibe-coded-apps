/**
 * Ask Trim — context bundle assembly (Task 6.10).
 *
 * `buildAskContext` is pure: takes plain arrays/objects, returns the JSON-able
 * blob that gets inlined into the system prompt. Easy to unit test against
 * hand-rolled fixtures.
 *
 * `loadAskContext` reads the DB for one user and calls `buildAskContext`.
 */

export const ASK_CONTEXT_DAYS = 90;
const RECENT_TRANSACTIONS_CAP = 60;
const PRIOR_MONTHS_BREAKDOWN = 3;

function isoDaysAgo(today, days) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function ym(iso) {
  return iso.slice(0, 7);
}

function monthRange(today, offsetMonths = 0) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - offsetMonths);
  const start = d.toISOString().slice(0, 10);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  const end = d.toISOString().slice(0, 10);
  return { ym: start.slice(0, 7), start, end };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function buildAskContext({
  today,
  currency,
  stats,
  categories,
  transactions,
  budgets,
  goals,
  contributions,
}) {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const cutoff = isoDaysAgo(today, ASK_CONTEXT_DAYS);

  const inWindow = transactions
    .filter((t) => t.date >= cutoff && t.date <= today)
    .sort((a, b) => (b.date === a.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date)));

  // Per-month totals (this, last, 2-months-ago).
  const monthlyTotals = [];
  for (let i = 0; i < PRIOR_MONTHS_BREAKDOWN; i++) {
    const r = monthRange(today, i);
    let income = 0;
    let expense = 0;
    let count = 0;
    for (const t of inWindow) {
      if (t.date >= r.start && t.date <= r.end) {
        count += 1;
        if (t.type === 'income') income += Number(t.amount);
        else expense += Number(t.amount);
      }
    }
    monthlyTotals.push({
      month: r.ym,
      income: round2(income),
      expense: round2(expense),
      net: round2(income - expense),
      transactionCount: count,
    });
  }

  // Per-category, per-month breakdown for the prior-months window — small table,
  // big payoff for "how much on X last month" questions.
  const categoryByMonth = [];
  for (let i = 0; i < PRIOR_MONTHS_BREAKDOWN; i++) {
    const r = monthRange(today, i);
    const sums = new Map();
    for (const t of inWindow) {
      if (t.date < r.start || t.date > r.end) continue;
      if (t.type !== 'expense') continue;
      const cat = catById.get(t.category_id);
      const key = cat ? cat.name : 'Uncategorised';
      sums.set(key, (sums.get(key) || 0) + Number(t.amount));
    }
    for (const [name, total] of sums.entries()) {
      categoryByMonth.push({ month: r.ym, category: name, total: round2(total) });
    }
  }

  // Current-month spent per budget category (for budget questions).
  const thisMonth = monthRange(today, 0);
  const spentByCatThisMonth = new Map();
  for (const t of inWindow) {
    if (t.type !== 'expense') continue;
    if (t.date < thisMonth.start || t.date > thisMonth.end) continue;
    spentByCatThisMonth.set(t.category_id, (spentByCatThisMonth.get(t.category_id) || 0) + Number(t.amount));
  }
  const budgetsOut = budgets.map((b) => {
    const cat = catById.get(b.category_id);
    const spent = spentByCatThisMonth.get(b.category_id) || 0;
    const limit = Number(b.amount_limit);
    return {
      category: cat ? cat.name : 'Uncategorised',
      period: b.period,
      limit: round2(limit),
      spentThisMonth: round2(spent),
      remaining: round2(limit - spent),
      percentUsed: limit > 0 ? Math.round((spent / limit) * 100) : 0,
    };
  });

  // Goals + recent contribution pace.
  const contribsByGoal = new Map();
  for (const c of contributions) {
    if (c.date < cutoff || c.date > today) continue;
    const list = contribsByGoal.get(c.goal_id) || [];
    list.push(c);
    contribsByGoal.set(c.goal_id, list);
  }
  const goalsOut = goals.map((g) => {
    const list = contribsByGoal.get(g.id) || [];
    const total = list.reduce((s, c) => s + Number(c.amount), 0);
    const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date));
    const target = Number(g.target_amount);
    const current = Number(g.current_amount);
    const percent = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
    const monthlyContribAvg = round2(total / (ASK_CONTEXT_DAYS / 30));
    return {
      name: g.name,
      emoji: g.emoji,
      target: round2(target),
      current: round2(current),
      remaining: round2(Math.max(0, target - current)),
      percent,
      targetDate: g.target_date || null,
      lastContributionAt: sorted[0]?.date || null,
      contributionTotalLast90d: round2(total),
      avgMonthlyContributionLast90d: monthlyContribAvg,
    };
  });

  // Recent transactions cap — most relevant for granular questions.
  const recent = inWindow.slice(0, RECENT_TRANSACTIONS_CAP).map((t) => {
    const cat = catById.get(t.category_id);
    const out = {
      date: t.date,
      amount: round2(Number(t.amount)),
      type: t.type,
      category: cat ? cat.name : 'Uncategorised',
    };
    if (t.description) out.description = t.description;
    return out;
  });

  return {
    asOf: today,
    currency,
    user: {
      displayName: stats?.display_name || null,
      simpleMode: !!stats?.simple_mode,
      streak: stats?.current_streak || 0,
      longestStreak: stats?.longest_streak || 0,
      level: stats?.level || 1,
    },
    monthlyTotals,
    categoryByMonth,
    budgets: budgetsOut,
    goals: goalsOut,
    recentTransactions: recent,
    recentTransactionsTruncated: inWindow.length > recent.length,
    transactionCountIn90Days: inWindow.length,
  };
}

export async function loadAskContext({ supabase, userId, today }) {
  const cutoff = isoDaysAgo(today, ASK_CONTEXT_DAYS);

  const [statsR, catsR, txR, budgetsR, goalsR, contribsR] = await Promise.all([
    supabase.from('user_stats').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('categories').select('id, name, type').eq('user_id', userId),
    supabase
      .from('transactions')
      .select('amount, type, description, date, category_id, created_at')
      .eq('user_id', userId)
      .gte('date', cutoff)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500),
    supabase.from('budgets').select('category_id, amount_limit, period').eq('user_id', userId),
    supabase
      .from('savings_goals')
      .select('id, name, emoji, target_amount, current_amount, target_date')
      .eq('user_id', userId),
    supabase
      .from('savings_contributions')
      .select('goal_id, amount, date')
      .eq('user_id', userId)
      .gte('date', cutoff),
  ]);

  for (const r of [statsR, catsR, txR, budgetsR, goalsR, contribsR]) {
    if (r.error) throw r.error;
  }

  return buildAskContext({
    today,
    currency: statsR.data?.currency || 'GBP',
    stats: statsR.data,
    categories: catsR.data || [],
    transactions: txR.data || [],
    budgets: budgetsR.data || [],
    goals: goalsR.data || [],
    contributions: contribsR.data || [],
  });
}
