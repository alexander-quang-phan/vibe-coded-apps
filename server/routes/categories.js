import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { suggestCategoryName } from '../lib/categoryKeywords.js';
import { ensureDefaultCategories } from '../lib/defaultCategories.js';
import { suggestFromHistory } from '../lib/merchantMemory.js';
import { merchantSearchTerm } from '../lib/merchant.js';
import { CURRENT_PHASE, writesCiphertext } from '../lib/encryptionPhase.js';
import { blindIndex } from '../lib/crypto.js';
import { isSingleEmoji } from '../lib/emoji.js';

const router = Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;

// Phase 10 (A3): users can now pick ANY emoji, so the old `.max(8)` UTF-16
// bound had to go — it rejected 👨‍👩‍👧‍👦 (11 units) while waving through
// "hack" and "🍔🍔🍔🍔". `.max(64)` is just a cheap outer bound before the
// real check, which is exactly-one-pictographic-grapheme.
const emojiField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isSingleEmoji, { message: 'Pick a single emoji.' });

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  icon: emojiField.default('📦'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  type: z.enum(['income', 'expense']),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    icon: emojiField.optional(),
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
    // Seed BEFORE reading. The client fires this and GET /api/me independently
    // and renders as soon as they resolve, so for a brand-new account this could
    // otherwise return — and cache — an empty list while /api/me was still
    // seeding. Idempotent, so whichever request gets here first does the work.
    // [Codex stage-5 RE-VERIFY #2 finding 6, 2026-08-18]
    await ensureDefaultCategories(supabase, req.user.id);

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

    // ONE normalisation, from lib/merchant.js. This route used to carry its own
    // inline copy that stripped apostrophes differently from lib/subscriptions.js
    // ("sainsbury s" vs "sainsburys"), so merchant memory had silently never
    // matched an apostrophe merchant.
    const term = merchantSearchTerm(desc);
    if (!term) {
      return res.json({ categoryId: null, confidence: 'none', source: 'none' });
    }

    if (writesCiphertext(CURRENT_PHASE)) {
      // Descriptions are ciphertext, so the database cannot answer `%term%`.
      // lib/merchantMemory.js keeps the behaviour identical: the blind index
      // narrows (keyset-paged, exact-tested), and a bounded recent-history scan
      // covers the mid-word and later-word matches the index cannot express.
      const fromHistory = await suggestFromHistory(supabase, { userId: req.user.id, typed: desc });
      if (fromHistory.categoryId) {
        return res.json({
          categoryId: fromHistory.categoryId,
          confidence: fromHistory.confidence,
          source: 'history',
        });
      }
    } else {
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
    }

    const keywordName = suggestCategoryName(desc);
    if (keywordName) {
      // After 019 `categories.name` does not exist; the blind index answers the
      // same exact-equality lookup. Before it, the plaintext is still the truth
      // (a dual-phase row may not have been repaired yet).
      let byName = supabase
        .from('categories')
        .select('id')
        .eq('user_id', req.user.id)
        .eq('type', 'expense');
      byName = CURRENT_PHASE === 'enc'
        ? byName.eq('name_hmac', blindIndex('categories.name_hmac', req.user.id, keywordName))
        : byName.eq('name', keywordName);
      const { data: cat, error: catErr } = await byName.maybeSingle();
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
