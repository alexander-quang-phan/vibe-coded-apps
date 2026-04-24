import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { titleForLevel, levelProgress } from '../lib/gamification.js';

const router = Router();

const prefsSchema = z.object({
  currency: z.enum(['GBP', 'USD', 'AUD', 'VND']).optional(),
  simpleMode: z.boolean().optional(),
  displayName: z.string().trim().max(50).optional().nullable(),
});

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('user_stats')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) throw error;

    let stats = data;
    if (!stats) {
      const { data: inserted, error: insertErr } = await supabase
        .from('user_stats')
        .insert({ user_id: req.user.id })
        .select('*')
        .single();
      if (insertErr) throw insertErr;
      stats = inserted;
    }

    const progress = levelProgress(stats.xp_points);

    res.json({
      user: { id: req.user.id, email: req.user.email },
      preferences: {
        currency: stats.currency,
        simpleMode: stats.simple_mode,
        displayName: stats.display_name,
      },
      stats: {
        currentStreak: stats.current_streak,
        longestStreak: stats.longest_streak,
        shields: stats.shields,
        xpPoints: stats.xp_points,
        level: stats.level,
        title: titleForLevel(stats.level),
        ...progress,
        badges: stats.badges,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const parsed = prefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid preferences', details: parsed.error.flatten() });
    }
    const payload = {};
    if (parsed.data.currency !== undefined) payload.currency = parsed.data.currency;
    if (parsed.data.simpleMode !== undefined) payload.simple_mode = parsed.data.simpleMode;
    if (parsed.data.displayName !== undefined) {
      payload.display_name = parsed.data.displayName || null;
    }
    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { data, error } = await supabase
      .from('user_stats')
      .update(payload)
      .eq('user_id', req.user.id)
      .select('currency, simple_mode, display_name')
      .single();
    if (error) throw error;

    res.json({
      preferences: {
        currency: data.currency,
        simpleMode: data.simple_mode,
        displayName: data.display_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
