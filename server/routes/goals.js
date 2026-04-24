import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';

const router = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  emoji: z.string().trim().max(8).optional().nullable(),
  targetAmount: z.number().positive().finite().max(1_000_000_000),
  targetDate: isoDate.optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  emoji: z.string().trim().max(8).optional().nullable(),
  targetAmount: z.number().positive().finite().max(1_000_000_000).optional(),
  targetDate: isoDate.optional().nullable(),
});

const contributionSchema = z.object({
  amount: z.number().positive().finite().max(1_000_000_000),
  note: z.string().trim().max(200).optional().nullable(),
});

function shape(goal) {
  const target = Number(goal.target_amount);
  const current = Number(goal.current_amount);
  return {
    id: goal.id,
    name: goal.name,
    emoji: goal.emoji,
    targetAmount: target,
    currentAmount: current,
    targetDate: goal.target_date,
    percent: target > 0 ? Math.min(current / target, 1) : 0,
    completed: current >= target,
    createdAt: goal.created_at,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('savings_goals')
      .select('id, name, emoji, target_amount, current_amount, target_date, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ goals: data.map(shape) });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid goal', details: parsed.error.flatten() });
    }
    const { name, emoji, targetAmount, targetDate } = parsed.data;
    const { data, error } = await supabase
      .from('savings_goals')
      .insert({
        user_id: req.user.id,
        name,
        emoji: emoji || null,
        target_amount: targetAmount,
        target_date: targetDate || null,
      })
      .select('id, name, emoji, target_amount, current_amount, target_date, created_at')
      .single();
    if (error) throw error;
    res.status(201).json({ goal: shape(data) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }
    const payload = {};
    if (parsed.data.name !== undefined) payload.name = parsed.data.name;
    if (parsed.data.emoji !== undefined) payload.emoji = parsed.data.emoji || null;
    if (parsed.data.targetAmount !== undefined) payload.target_amount = parsed.data.targetAmount;
    if (parsed.data.targetDate !== undefined) payload.target_date = parsed.data.targetDate || null;
    if (Object.keys(payload).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const { data, error } = await supabase
      .from('savings_goals')
      .update(payload)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, name, emoji, target_amount, current_amount, target_date, created_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Goal not found' });
    res.json({ goal: shape(data) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid id' });
    const { error } = await supabase
      .from('savings_goals')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/goals/:id/contributions — add money toward a goal.
// Returns the updated goal + a milestone flag for the UI to celebrate.
router.post('/:id/contributions', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const parsed = contributionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid contribution', details: parsed.error.flatten() });
    }
    const { amount, note } = parsed.data;

    const { data: goal, error: goalErr } = await supabase
      .from('savings_goals')
      .select('id, name, emoji, target_amount, current_amount, target_date, created_at')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (goalErr) throw goalErr;
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    const beforePct = Number(goal.target_amount) > 0 ? Number(goal.current_amount) / Number(goal.target_amount) : 0;
    const newAmount = Number(goal.current_amount) + amount;
    const afterPct = Number(goal.target_amount) > 0 ? newAmount / Number(goal.target_amount) : 0;

    const { error: contribErr } = await supabase
      .from('savings_contributions')
      .insert({ goal_id: id, user_id: req.user.id, amount, note: note || null });
    if (contribErr) throw contribErr;

    const { data: updated, error: updErr } = await supabase
      .from('savings_goals')
      .update({ current_amount: newAmount })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, name, emoji, target_amount, current_amount, target_date, created_at')
      .single();
    if (updErr) throw updErr;

    // Detect which milestone thresholds were just crossed (25/50/75/100).
    const thresholds = [0.25, 0.5, 0.75, 1.0];
    const crossed = thresholds.filter((t) => beforePct < t && afterPct >= t);
    const milestone = crossed.length > 0 ? crossed[crossed.length - 1] : null;

    res.status(201).json({
      goal: shape(updated),
      milestone,
      justCompleted: beforePct < 1 && afterPct >= 1,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
