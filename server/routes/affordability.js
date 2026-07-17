import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { excludeSpecial } from '../lib/special.js';

const router = Router();

const checkSchema = z.object({
  amount: z.number().positive().finite().max(1_000_000_000),
  categoryId: z.string().uuid().optional().nullable(),
});

function monthBounds(d = new Date()) {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const nextFirst = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return {
    firstISO: first.toISOString().slice(0, 10),
    nextFirstISO: nextFirst.toISOString().slice(0, 10),
  };
}

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
    const { amount, categoryId } = parsed.data;
    const { firstISO, nextFirstISO } = monthBounds();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();

    const [budgetsRes, txRes, goalsRes, contribsRes, statsRes] = await Promise.all([
      supabase
        .from('budgets')
        .select('category_id, amount_limit')
        .eq('user_id', req.user.id)
        .eq('period', 'monthly'),
      supabase
        .from('transactions')
        .select('amount, category_id, is_special')
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .gte('date', firstISO)
        .lt('date', nextFirstISO),
      supabase
        .from('savings_goals')
        .select('id, name, emoji, target_amount, current_amount, target_date, created_at')
        .eq('user_id', req.user.id),
      supabase
        .from('savings_contributions')
        .select('amount, created_at')
        .eq('user_id', req.user.id)
        .gte('created_at', ninetyDaysAgo),
      supabase
        .from('user_stats')
        .select('special_expenses_enabled')
        .eq('user_id', req.user.id)
        .single(),
    ]);
    for (const r of [budgetsRes, txRes, goalsRes, contribsRes, statsRes]) if (r.error) throw r.error;

    const specialEnabled = !!statsRes.data.special_expenses_enabled;
    const countable = excludeSpecial(txRes.data, specialEnabled);

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
      const budget = budgetsRes.data.find((b) => b.category_id === categoryId);
      if (budget) {
        categoryLimit = Number(budget.amount_limit);
        const spent = spendByCat.get(categoryId) ?? 0;
        categoryRemaining = round2(categoryLimit - spent - amount);
      }
    }

    // Total remaining across all monthly budgets — null when none are set.
    let totalRemaining = null;
    let totalLimit = 0;
    if (budgetsRes.data.length > 0) {
      totalLimit = budgetsRes.data.reduce((sum, b) => sum + Number(b.amount_limit), 0);
      const budgetedCatIds = new Set(budgetsRes.data.map((b) => b.category_id));
      const budgetedSpend = [...spendByCat.entries()]
        .filter(([catId]) => budgetedCatIds.has(catId))
        .reduce((sum, [, v]) => sum + v, 0);
      totalRemaining = round2(totalLimit - budgetedSpend - amount);
    }

    // Goal impact — soonest-target_date open goal, falling back to
    // earliest-created open goal. Needs recent contributions to know the pace.
    const openGoals = goalsRes.data.filter(
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

      const contributed = contribsRes.data.reduce((sum, c) => sum + Number(c.amount), 0);
      if (contributed > 0) {
        const dailyRate = contributed / 90;
        goalImpactDays = Math.max(1, Math.round(amount / dailyRate));
        goal = { id: picked.id, name: picked.name, emoji: picked.emoji };
      }
    }

    res.json({
      categoryRemaining,
      totalRemaining,
      goalImpactDays,
      goal,
      verdict: verdictFor({ categoryRemaining, totalRemaining, categoryLimit, totalLimit }),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
