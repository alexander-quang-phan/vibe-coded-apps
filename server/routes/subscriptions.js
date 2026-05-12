import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { detectSubscriptions } from '../lib/subscriptions.js';

const router = Router();

const DESCRIPTION_KEY = /^[a-z0-9 ]{1,100}$/;
const SYNTHETIC_KEY = /^auto:(?:[a-f0-9-]{36}|none):\d+:(?:monthly|annual)$/;
const MAX_DISPLAY_NAME = 40;

const patchSchema = z
  .object({
    status: z.enum(['active', 'cancelled', 'dismissed']).optional(),
    displayName: z.string().nullable().optional(),
  })
  .refine((d) => d.status !== undefined || d.displayName !== undefined, {
    message: 'Provide status or displayName',
  });

function isValidMerchantKey(key) {
  return DESCRIPTION_KEY.test(key) || SYNTHETIC_KEY.test(key);
}

function summarise(subscriptions) {
  const active = subscriptions.filter((s) => s.status === 'active');
  const cancelled = subscriptions.filter((s) => s.status === 'cancelled');
  const dismissed = subscriptions.filter((s) => s.status === 'dismissed');
  const activeMonthly = active.reduce((sum, s) => sum + s.monthlyCost, 0);
  const cancelledMonthly = cancelled.reduce((sum, s) => sum + s.monthlyCost, 0);
  return {
    activeCount: active.length,
    cancelledCount: cancelled.length,
    dismissedCount: dismissed.length,
    activeMonthly: Number(activeMonthly.toFixed(2)),
    activeAnnual: Number((activeMonthly * 12).toFixed(2)),
    cancelledMonthly: Number(cancelledMonthly.toFixed(2)),
    cancelledAnnual: Number((cancelledMonthly * 12).toFixed(2)),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const [txRes, overridesRes, catsRes] = await Promise.all([
      supabase
        .from('transactions')
        .select('id, amount, type, description, date, category_id')
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .order('date', { ascending: true }),
      supabase
        .from('subscription_overrides')
        .select('merchant_key, status, display_name, decided_at')
        .eq('user_id', req.user.id),
      supabase
        .from('categories')
        .select('id, name, icon, color')
        .eq('user_id', req.user.id),
    ]);

    for (const r of [txRes, overridesRes, catsRes]) if (r.error) throw r.error;

    const overridesByKey = new Map(
      overridesRes.data.map((o) => [o.merchant_key, o]),
    );
    const catsById = new Map(catsRes.data.map((c) => [c.id, c]));

    const detected = detectSubscriptions(txRes.data);
    const subscriptions = detected.map((d) => {
      const override = overridesByKey.get(d.merchantKey);
      const cat = d.categoryId ? catsById.get(d.categoryId) : null;
      return {
        ...d,
        category: cat
          ? { id: cat.id, name: cat.name, icon: cat.icon, color: cat.color }
          : null,
        status: override?.status ?? 'active',
        displayName: override?.display_name ?? null,
        decidedAt: override?.decided_at ?? null,
      };
    });

    res.json({ subscriptions, summary: summarise(subscriptions) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:merchantKey', async (req, res, next) => {
  try {
    const merchantKey = decodeURIComponent(req.params.merchantKey);
    if (!isValidMerchantKey(merchantKey)) {
      return res.status(400).json({ error: 'Invalid merchant key' });
    }

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }

    const status = parsed.data.status;
    let displayName = parsed.data.displayName;
    if (typeof displayName === 'string') {
      displayName = displayName.trim();
      if (displayName.length === 0) displayName = null;
      else if (displayName.length > MAX_DISPLAY_NAME) {
        return res
          .status(400)
          .json({ error: `Display name must be ${MAX_DISPLAY_NAME} characters or fewer.` });
      }
    }

    const { data: existing, error: readErr } = await supabase
      .from('subscription_overrides')
      .select('status, display_name, decided_at')
      .eq('user_id', req.user.id)
      .eq('merchant_key', merchantKey)
      .maybeSingle();
    if (readErr) throw readErr;

    const merged = {
      user_id: req.user.id,
      merchant_key: merchantKey,
      status: status ?? existing?.status ?? 'active',
      display_name:
        displayName !== undefined ? displayName : existing?.display_name ?? null,
      decided_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('subscription_overrides')
      .upsert(merged, { onConflict: 'user_id,merchant_key' })
      .select('merchant_key, status, display_name, decided_at')
      .single();

    if (error) throw error;

    res.json({
      override: {
        merchantKey: data.merchant_key,
        status: data.status,
        displayName: data.display_name,
        decidedAt: data.decided_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
