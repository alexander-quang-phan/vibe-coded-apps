import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { excludeSpecial } from '../lib/special.js';
import { resolveTotalBudget } from '../lib/overallBudget.js';
import { monthBounds } from '../lib/month.js';
import { userTimeZone } from '../lib/userZone.js';

import { selectFor, decodeRow, decodeRows } from '../lib/encryptionCodec.js';

const router = Router();

// Phase 9.5 Part A. Read-only; every response field is named, so decoding at the
// boundary is the whole job.
const AFF_BUDGET_COLUMNS = 'category_id, amount_limit';
const AFF_TX_COLUMNS = 'amount, category_id, is_special';
const AFF_GOAL_COLUMNS = 'id, name, emoji, target_amount, current_amount, target_date, created_at';
const AFF_CONTRIB_COLUMNS = 'amount, created_at';
const AFF_STATS_COLUMNS = 'special_expenses_enabled, monthly_limit';

const checkSchema = z.object({
  amount: z.number().positive().finite().max(1_000_000_000),
  categoryId: z.string().uuid().optional().nullable(),
  // Mirrors the Dashboard hero's incl./excl.-special toggle. Omitted or false
  // keeps the original behaviour — special spend sits outside the budget, which
  // is the point of the flag. True counts it, so the answer matches the total
  // the user is looking at directly above this card.
  includeSpecial: z.boolean().optional(),
});

// monthBounds now lives in lib/month.js and takes the user's timezone.

const round2 = (n) => Number(n.toFixed(2));

// Verdict is deliberately gentle — never "you can't afford it".
function verdictFor({ categoryRemaining, totalRemaining, categoryLimit, totalLimit }) {
  const signals = [];
  if (categoryRemaining !== null && categoryLimit > 0) {
    signals.push({ remaining: categoryRemaining, limit: categoryLimit });
  }
  if (totalRemaining !== null && totalLimit > 0) {
    signals.push({ remaining: totalRemaining, limit: totalLimit });
  }
  if (signals.length === 0) return 'Comfortably yes';
  if (signals.some((s) => s.remaining < 0)) return 'Would push you over';
  if (signals.some((s) => s.remaining < s.limit * 0.15)) return 'Tight but yes';
  return 'Comfortably yes';
}

// POST /api/affordability — pure read + compute, no writes (Task 6.4).
router.post('/', async (req, res, next) => {
  try {
    const parsed = checkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid check', details: parsed.error.flatten() });
    }
    const { amount, categoryId, includeSpecial } = parsed.data;
    const { firstISO, nextFirstISO } = monthBounds(await userTimeZone(req.user.id));
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();

    const [budgetsRes, txRes, goalsRes, contribsRes, statsRes] = await Promise.all([
      supabase
        .from('budgets')
        .select(selectFor('budgets', AFF_BUDGET_COLUMNS))
        .eq('user_id', req.user.id)
        .eq('period', 'monthly'),
      supabase
        .from('transactions')
        .select(selectFor('transactions', AFF_TX_COLUMNS))
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .gte('date', firstISO)
        .lt('date', nextFirstISO),
      supabase
        .from('savings_goals')
        .select(selectFor('savings_goals', AFF_GOAL_COLUMNS))
        .eq('user_id', req.user.id),
      supabase
        .from('savings_contributions')
        .select(selectFor('savings_contributions', AFF_CONTRIB_COLUMNS))
        .eq('user_id', req.user.id)
        .gte('created_at', ninetyDaysAgo),
      supabase
        .from('user_stats')
        .select(selectFor('user_stats', AFF_STATS_COLUMNS))
        .eq('user_id', req.user.id)
        .single(),
    ]);
    for (const r of [budgetsRes, txRes, goalsRes, contribsRes, statsRes]) if (r.error) throw r.error;

    // Decode once, at the boundary; every calculation below is unchanged.
    const uid = req.user.id;
    const budgetRows = decodeRows('budgets', uid, budgetsRes.data);
    const txRows = decodeRows('transactions', uid, txRes.data);
    const goalRows = decodeRows('savings_goals', uid, goalsRes.data);
    const contribRows = decodeRows('savings_contributions', uid, contribsRes.data);
    const stats = decodeRow('user_stats', uid, statsRes.data);

    const specialEnabled = !!stats.special_expenses_enabled;
    // `specialEnabled && !includeSpecial` — the flag only excludes while the
    // preference is on AND the user is viewing the excl. total.
    const countable = excludeSpecial(txRows, specialEnabled && !includeSpecial);

    const spendByCat = new Map();
    let totalSpent = 0;
    for (const t of countable) {
      const amt = Number(t.amount);
      spendByCat.set(t.category_id, (spendByCat.get(t.category_id) ?? 0) + amt);
      totalSpent += amt;
    }

    // Category remaining — only when a category was picked AND it has a
    // monthly budget.
    let categoryRemaining = null;
    let categoryLimit = 0;
    if (categoryId) {
      const budget = budgetRows.find((b) => b.category_id === categoryId);
      if (budget) {
        categoryLimit = Number(budget.amount_limit);
        const spent = spendByCat.get(categoryId) ?? 0;
        categoryRemaining = round2(categoryLimit - spent - amount);
      }
    }

    // Total remaining — null when there's nothing to measure against.
    // Phase 10 (A5): an overall monthly budget, when set, IS the total and
    // every category counts toward it. Otherwise this falls back to the sum of
    // the category budgets measured against budgeted spend only, exactly as
    // before. Shared with projections.js so both agree — they used to differ.
    const resolved = resolveTotalBudget({
      monthlyLimit: stats.monthly_limit,
      monthlyBudgets: budgetRows,
      spendByCat,
    });
    const totalLimit = resolved.limit ?? 0;
    const totalRemaining =
      resolved.limit === null ? null : round2(resolved.limit - resolved.spent - amount);
    const totalSource = resolved.source;

    // Goal impact — soonest-target_date open goal, falling back to
    // earliest-created open goal. Needs recent contributions to know the pace.
    const openGoals = goalRows.filter(
      (g) => Number(g.current_amount) < Number(g.target_amount),
    );
    let goal = null;
    let goalImpactDays = null;
    if (openGoals.length > 0) {
      const dated = openGoals
        .filter((g) => g.target_date)
        .sort((a, b) => a.target_date.localeCompare(b.target_date));
      const fallback = [...openGoals].sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
      const picked = dated[0] ?? fallback[0];

      const contributed = contribRows.reduce((sum, c) => sum + Number(c.amount), 0);
      if (contributed > 0) {
        const dailyRate = contributed / 90;
        goalImpactDays = Math.max(1, Math.round(amount / dailyRate));
        goal = { id: picked.id, name: picked.name, emoji: picked.emoji };
      }
    }

    res.json({
      categoryRemaining,
      totalRemaining,
      // Lets the client say "left in your monthly budget" vs "left across all
      // budgets" — two genuinely different claims.
      totalSource,
      goalImpactDays,
      goal,
      verdict: verdictFor({ categoryRemaining, totalRemaining, categoryLimit, totalLimit }),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
