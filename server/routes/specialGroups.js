import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';

import { selectFor, decodeRow, decodeRows, encodeWrite } from '../lib/encryptionCodec.js';

const router = Router();

// Phase 9.5 Part A. `special_groups.name` is encrypted, and the totals are built
// from `transactions.amount`. Responses are assembled field by field, so decoding
// at the boundary is enough.
const GROUP_COLUMNS = 'id, name, archived_at, created_at';
const GROUP_PATCH_COLUMNS = 'id, name, archived_at';
const GROUP_TX_COLUMNS = 'amount, date, special_group_id, is_special';

const UUID_RE = /^[0-9a-f-]{36}$/i;

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    archived: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.archived !== undefined, {
    message: 'Provide name or archived',
  });

const round2 = (n) => Number(n.toFixed(2));

/**
 * GET /api/special-groups — every group with its running total.
 *
 * Totals are LIFETIME, not this-month: a Paris trip is paid for across several
 * months, and a total that reset on the 1st would be useless for exactly the
 * case this feature exists for.
 *
 * Only `is_special` expenses count toward a group's total. The group column is
 * only ever set on special expenses (guarded in routes/transactions.js), but
 * filtering here too means un-starring a transaction immediately drops it out
 * of its group's total rather than leaving a stale number behind.
 */
router.get('/', async (req, res, next) => {
  try {
    const [groupsRes, txRes] = await Promise.all([
      supabase
        .from('special_groups')
        .select(selectFor('special_groups', GROUP_COLUMNS))
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('transactions')
        .select(selectFor('transactions', GROUP_TX_COLUMNS))
        .eq('user_id', req.user.id)
        .eq('type', 'expense')
        .eq('is_special', true)
        .not('special_group_id', 'is', null),
    ]);
    for (const r of [groupsRes, txRes]) if (r.error) throw r.error;

    const byGroup = new Map();
    const groupRows = decodeRows('special_groups', req.user.id, groupsRes.data);
    for (const t of decodeRows('transactions', req.user.id, txRes.data)) {
      const g = byGroup.get(t.special_group_id) ?? { total: 0, count: 0, dates: [] };
      g.total += Number(t.amount);
      g.count += 1;
      g.dates.push(t.date);
      byGroup.set(t.special_group_id, g);
    }

    const groups = groupRows.map((g) => {
      const agg = byGroup.get(g.id);
      const dates = agg ? [...agg.dates].sort() : [];
      return {
        id: g.id,
        name: g.name,
        archivedAt: g.archived_at,
        total: round2(agg?.total ?? 0),
        count: agg?.count ?? 0,
        firstDate: dates[0] ?? null,
        lastDate: dates.at(-1) ?? null,
      };
    });

    res.json({ groups });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid group', details: parsed.error.flatten() });
    }
    const { data, error } = await supabase
      .from('special_groups')
      .insert(encodeWrite('special_groups', req.user.id, { user_id: req.user.id, name: parsed.data.name }))
      .select(selectFor('special_groups', GROUP_COLUMNS))
      .single();
    if (error) throw error;
    // Decode before reading `.name`: at phase enc the plaintext column does not
    // exist, and the response would carry `undefined`.
    const created = decodeRow('special_groups', req.user.id, data);
    res.status(201).json({
      group: {
        id: created.id,
        name: created.name,
        archivedAt: created.archived_at,
        total: 0,
        count: 0,
        firstDate: null,
        lastDate: null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Group not found' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }
    const payload = {};
    if (parsed.data.name !== undefined) payload.name = parsed.data.name;
    if (parsed.data.archived !== undefined) {
      payload.archived_at = parsed.data.archived ? new Date().toISOString() : null;
    }

    const { data, error } = await supabase
      .from('special_groups')
      .update(encodeWrite('special_groups', req.user.id, payload))
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select(selectFor('special_groups', GROUP_PATCH_COLUMNS))
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Group not found' });

    const updated = decodeRow('special_groups', req.user.id, data);
    res.json({ group: { id: updated.id, name: updated.name, archivedAt: updated.archived_at } });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE removes the GROUP only. `on delete set null` on
 * transactions.special_group_id means the spending survives, simply ungrouped —
 * deleting a label must never delete the money it labelled.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Group not found' });
    const { data, error } = await supabase
      .from('special_groups')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Group not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
