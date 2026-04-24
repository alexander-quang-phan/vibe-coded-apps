import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  icon: z.string().trim().min(1).max(8).default('📦'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  type: z.enum(['income', 'expense']),
});

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('id, name, icon, color, type, is_default, sort_order')
      .eq('user_id', req.user.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ categories: data });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid category', details: parsed.error.flatten() });
    }
    const { name, icon, color, type } = parsed.data;

    const { data, error } = await supabase
      .from('categories')
      .insert({ user_id: req.user.id, name, icon, color, type, is_default: false })
      .select('id, name, icon, color, type, is_default, sort_order')
      .single();

    if (error) throw error;
    res.status(201).json({ category: data });
  } catch (err) {
    next(err);
  }
});

export default router;
