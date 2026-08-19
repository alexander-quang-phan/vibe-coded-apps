import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { buildRunningAverage } from '../lib/runningAverage.js';
import { ymInZone, addMonths } from '../lib/month.js';
import { userTimeZone } from '../lib/userZone.js';

import { selectFor, decodeRows } from '../lib/encryptionCodec.js';

const router = Router();

// Phase 9.5 Part A. Read-only and fully aggregated, so decoding at the boundary
// is the whole job. `user_stats` is read for `special_expenses_enabled` only,
// which is not encrypted.
const ANALYTICS_TX_COLUMNS = 'amount, type, date, category_id, is_special';
const ANALYTICS_CAT_COLUMNS = 'id, name, icon, color, type';

// Month keys are built by string arithmetic from the user's own current month
// (lib/month.js), not from the server's UTC clock. The label is derived from the
// key so it can never disagree with it.
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthLabel(ym) {
  return MONTH_LABELS[Number(ym.slice(5, 7)) - 1];
}

// GET /api/analytics?months=6
// Returns: { series: [{ ym, label, income, expenses, net }],
//            topCategories: [{ categoryId, name, icon, color, total }],
//            mom: { thisMonth, lastMonth, deltaPct } }
router.get('/', async (req, res, next) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);

    const timeZone = await userTimeZone(req.user.id);
    const thisYm = ymInZone(timeZone);
    const startYm = addMonths(thisYm, -(months - 1));
    const startISO = `${startYm}-01`;
    const endISO = `${addMonths(thisYm, 1)}-01`;

    const [txRes, catsRes, statsRes] = await Promise.all([
      supabase
        .from('transactions')
        .select(selectFor('transactions', ANALYTICS_TX_COLUMNS))
        .eq('user_id', req.user.id)
        .gte('date', startISO)
        .lt('date', endISO),
      supabase
        .from('categories')
        .select(selectFor('categories', ANALYTICS_CAT_COLUMNS))
        .eq('user_id', req.user.id),
      supabase
        .from('user_stats')
        .select('special_expenses_enabled')
        .eq('user_id', req.user.id)
        .single(),
    ]);
    if (txRes.error) throw txRes.error;
    if (catsRes.error) throw catsRes.error;
    if (statsRes.error) throw statsRes.error;

    const specialEnabled = !!statsRes.data.special_expenses_enabled;

    // Decode once, at the boundary; every calculation below is unchanged.
    const txRows = decodeRows('transactions', req.user.id, txRes.data);
    const catRows = decodeRows('categories', req.user.id, catsRes.data);

    // Build empty months series (ascending).
    const series = [];
    for (let i = 0; i < months; i++) {
      const ym = addMonths(startYm, i);
      series.push({ ym, label: monthLabel(ym), income: 0, expenses: 0, net: 0, special: 0 });
    }
    const seriesByYm = new Map(series.map((s) => [s.ym, s]));

    const catsById = new Map(catRows.map((c) => [c.id, c]));

    const lastYm = addMonths(thisYm, -1);

    const catTotalsThisMonth = new Map();

    for (const t of txRows) {
      // The date column is already a calendar day string — slicing it is exact,
      // where re-parsing it into a Date only reintroduces zone questions.
      const ym = t.date.slice(0, 7);
      const bucket = seriesByYm.get(ym);
      if (!bucket) continue;
      const amount = Number(t.amount);
      if (t.type === 'income') bucket.income += amount;
      else bucket.expenses += amount;
      // Expenses only — this query fetches income rows too, and sumSpecial()
      // in lib/special.js applies the same guard.
      if (t.is_special && specialEnabled && t.type !== 'income') bucket.special += amount;

      if (ym === thisYm && t.type === 'expense') {
        catTotalsThisMonth.set(t.category_id, (catTotalsThisMonth.get(t.category_id) ?? 0) + amount);
      }
    }

    for (const s of series) {
      s.income = Number(s.income.toFixed(2));
      s.expenses = Number(s.expenses.toFixed(2));
      s.net = Number((s.income - s.expenses).toFixed(2));
      s.special = Number(s.special.toFixed(2));
    }

    const topCategories = [...catTotalsThisMonth.entries()]
      .map(([categoryId, total]) => {
        const cat = catsById.get(categoryId);
        return {
          categoryId,
          name: cat?.name ?? 'Unknown',
          icon: cat?.icon ?? null,
          color: cat?.color ?? null,
          total: Number(total.toFixed(2)),
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    const thisMonthBucket = seriesByYm.get(thisYm);
    const lastMonthBucket = seriesByYm.get(lastYm);
    const thisMonthExpenses = thisMonthBucket?.expenses ?? 0;
    const lastMonthExpenses = lastMonthBucket?.expenses ?? 0;
    const deltaPct =
      lastMonthExpenses > 0
        ? Number((((thisMonthExpenses - lastMonthExpenses) / lastMonthExpenses) * 100).toFixed(1))
        : null;

    // Three windows in one response so the card's 3m / 6m / 12m switch needs no
    // refetch. Two extra passes over an in-memory array of at most 24 entries.
    // `windows` is all-or-nothing: buildRunningAverage only returns null when
    // there is no completed month at all, which is true for every window or none.
    const windows = [3, 6, 12]
      .map((n) => buildRunningAverage({ series, months: n, currentYm: thisYm }))
      .filter(Boolean);

    // thisMonth* sit outside `windows` because they do not vary by window, and
    // they are read straight from the current bucket — untouched by the trimming
    // and windowing that shape the averages.
    const average = windows.length
      ? {
          windows,
          thisMonthSoFar: thisMonthExpenses,
          thisMonthSpecial: thisMonthBucket?.special ?? 0,
        }
      : null;

    res.json({
      series,
      average,
      topCategories,
      mom: {
        thisMonth: thisMonthExpenses,
        lastMonth: lastMonthExpenses,
        deltaPct,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
