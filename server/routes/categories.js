import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { suggestCategoryName } from '../lib/categoryKeywords.js';

const router = Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  icon: z.string().trim().min(1).max(8).default('📦'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  type: z.enum(['income', 'expense']),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    icon: z.string().trim().min(1).max(8).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  })
  .refine((d) => d.name !== undefined || d.icon !== undefined || d.color !== undefined, {
    message: 'Provide at least one of name, icon, color',
  });

// Seeded reassign-target categories — protected from deletion so users can't
// orphan themselves. Detected by (is_default + name) so a renamed default
// loses the protection (acceptable: the user explicitly took action).
const PROTECTED_DEFAULT_NAMES = new Set(['Other', 'Other Income']);

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

// GET /api/categories/suggest?desc=… (Task 6.9)
// History first (what did the user file this merchant under before?), then
// the keyword map for first-time merchants. Highlight-only on the client —
// never auto-selects.
router.get('/suggest', async (req, res, next) => {
  try {
    const desc = String(req.query.desc ?? '').trim();
    if (desc.length < 2) {
      return res.json({ categoryId: null, confidence: 'none', source: 'none' });
    }

    // Match on the first two words, mirroring the subscription detector's
    // merchant normalisation.
    const term = desc
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 2)
      .join(' ');
    if (!term) {
      return res.json({ categoryId: null, confidence: 'none', source: 'none' });
    }

    const { data: matches, error } = await supabase
      .from('transactions')
      .select('category_id')
      .eq('user_id', req.user.id)
      .ilike('description', `%${term}%`)
      .limit(200);
    if (error) throw error;

    if (matches && matches.length > 0) {
      const counts = new Map();
      for (const m of matches) {
        counts.set(m.category_id, (counts.get(m.category_id) ?? 0) + 1);
      }
      const [categoryId, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return res.json({
        categoryId,
        confidence: count >= 3 ? 'high' : 'medium',
        source: 'history',
      });
    }

    const keywordName = suggestCategoryName(desc);
    if (keywordName) {
      const { data: cat, error: catErr } = await supabase
        .from('categories')
        .select('id')
        .eq('user_id', req.user.id)
        .eq('name', keywordName)
        .eq('type', 'expense')
        .maybeSingle();
      if (catErr) throw catErr;
      if (cat) {
        return res.json({ categoryId: cat.id, confidence: 'medium', source: 'keyword' });
      }
    }

    res.json({ categoryId: null, confidence: 'none', source: 'none' });
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

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }

    const payload = {};
    if (parsed.data.name !== undefined) payload.name = parsed.data.name;
    if (parsed.data.icon !== undefined) payload.icon = parsed.data.icon;
    if (parsed.data.color !== undefined) payload.color = parsed.data.color;

    const { data, error } = await supabase
      .from('categories')
      .update(payload)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, name, icon, color, type, is_default, sort_order')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Category not found' });
    res.json({ category: data });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const { data: cat, error: catErr } = await supabase
      .from('categories')
      .select('id, name, type, is_default')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!cat) return res.status(404).json({ error: 'Category not found' });

    if (cat.is_default && PROTECTED_DEFAULT_NAMES.has(cat.name)) {
      return res
        .status(403)
        .json({ error: "This category is your reassign safety net — it can't be deleted." });
    }

    const { count: txCount, error: txCountErr } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('category_id', id);
    if (txCountErr) throw txCountErr;

    const reassignTo = req.query.reassign_to;

    if (txCount > 0 && !reassignTo) {
      return res
        .status(409)
        .json({ error: 'Category has transactions', transactionCount: txCount });
    }

    if (txCount > 0 && reassignTo) {
      if (!UUID_RE.test(reassignTo)) {
        return res.status(400).json({ error: 'Invalid reassign_to id' });
      }
      if (reassignTo === id) {
        return res.status(400).json({ error: 'Cannot reassign to the category being deleted' });
      }
      const { data: target, error: targetErr } = await supabase
        .from('categories')
        .select('id, type')
        .eq('id', reassignTo)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (targetErr) throw targetErr;
      if (!target) return res.status(404).json({ error: 'Reassign target not found' });
      if (target.type !== cat.type) {
        return res.status(400).json({ error: 'Reassign target must be the same type' });
      }

      const { error: reassignErr } = await supabase
        .from('transactions')
        .update({ category_id: reassignTo })
        .eq('user_id', req.user.id)
        .eq('category_id', id);
      if (reassignErr) throw reassignErr;
    }

    // Cascade in the schema removes the budget on this category too.
    const { error: delErr } = await supabase
      .from('categories')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
    if (delErr) throw delErr;

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
