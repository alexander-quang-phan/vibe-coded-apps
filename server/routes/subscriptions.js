import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { detectSubscriptions } from '../lib/subscriptions.js';

const router = Router();

const merchantKeyParam = /^[a-z0-9 ]{1,100}$/;

const patchSchema = z.object({
  status: z.enum(['active', 'cancelled']),
});

function summarise(subscriptions) {
  const active = subscriptions.filter((s) => s.status === 'active');
  const cancelled = subscriptions.filter((s) => s.status === 'cancelled');
  const activeMonthly = active.reduce((sum, s) => sum + s.monthlyCost, 0);
  const cancelledMonthly = cancelled.reduce((sum, s) => sum + s.monthlyCost, 0);
  return {
    activeCount: active.length,
    cancelledCount: cancelled.length,
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
        .select('merchant_key, status, decided_at')
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
    if (!merchantKeyParam.test(merchantKey)) {
      return res.status(400).json({ error: 'Invalid merchant key' });
    }

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }

    const { data, error } = await supabase
      .from('subscription_overrides')
      .upsert(
        {
          user_id: req.user.id,
          merchant_key: merchantKey,
          status: parsed.data.status,
          decided_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,merchant_key' },
      )
      .select('merchant_key, status, decided_at')
      .single();

    if (error) throw error;

    res.json({
      override: {
        merchantKey: data.merchant_key,
        status: data.status,
        decidedAt: data.decided_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
