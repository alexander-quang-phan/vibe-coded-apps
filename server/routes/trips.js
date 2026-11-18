// Phase 18 — trips. Spec: docs/superpowers/specs/2026-10-13-trips-design.md
//
// A trip owns the star on its expenses and nothing else: spending leaves monthly
// budgets through the one existing rule in lib/special.js. Every figure comes from
// lib/trips.js and every rule from lib/tripRules.js, so devMock can't disagree.
//
// Names and budgets are encrypted, so all arithmetic happens in JS after decodeRows,
// and responses are built field by field (presentTrip). The service role bypasses RLS,
// so every query carries .eq('user_id', req.user.id).
import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { selectFor, decodeRow, decodeRows, encodeWrite, presentRows } from '../lib/encryptionCodec.js';
import { dayInZone } from '../lib/month.js';
import { userTimeZone } from '../lib/userZone.js';
import { readAllPages } from '../lib/readAllPages.js';
import { TX_LIST_COLUMNS } from '../lib/txColumns.js';
import {
  summariseTrip, presentTrip, groupByTrip, splitUntagged, untaggedWindowStart,
} from '../lib/trips.js';
import {
  tripCreateSchema, tripPatchSchema, fromGroupSchema, bulkAddSchema, DELETE_MODES,
  checkTripPlan, checkTripCategories, stopRow, diffStops, diffCategoryBudgets,
  allCategoryLines, diffCityBudgets, cityLinesFor,
} from '../lib/tripRules.js';

const router = Router();

// A real UUID: the looser [0-9a-f-]{36} let 36 dashes through to PostgreSQL as a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRIP_COLUMNS = 'id, name, start_date, end_date, total_budget, keep_out_of_monthly, city_category_budgets, source_group_id, archived_at, created_at';
const STOP_COLUMNS = 'id, trip_id, name, start_date, end_date, budget, currency, created_at';
// stop_id NULL is a whole-trip line; set, it's that city's (017c).
const BUDGET_COLUMNS = 'id, trip_id, stop_id, category_id, amount_limit, created_at';
// Lean: what the figures need, for every trip at once. `id` because paging orders by it.
const FIGURE_TX_COLUMNS = 'id, trip_id, amount, date, category_id, trip_stop_id';
const UNTAGGED_COLUMNS = 'id, amount, date, description, category_id, original_amount, original_currency, created_at';

const todayFor = async (uid) => dayInZone(await userTimeZone(uid));

async function readTripRow(uid, id) {
  const { data, error } = await supabase
    .from('trips')
    .select(selectFor('trips', TRIP_COLUMNS))
    .eq('id', id)
    .eq('user_id', uid)
    .maybeSingle();
  if (error) throw error;
  return data ? decodeRow('trips', uid, data) : null;
}

async function readStops(uid, tripId) {
  const { data, error } = await supabase
    .from('trip_stops')
    .select(selectFor('trip_stops', STOP_COLUMNS))
    .eq('trip_id', tripId)
    .eq('user_id', uid)
    .order('start_date', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return decodeRows('trip_stops', uid, data);
}

async function readBudgets(uid, tripId) {
  const { data, error } = await supabase
    .from('trip_category_budgets')
    .select(selectFor('trip_category_budgets', BUDGET_COLUMNS))
    .eq('trip_id', tripId)
    .eq('user_id', uid)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return decodeRows('trip_category_budgets', uid, data);
}

/** Every full transaction row on one trip, past the row cap. */
const readTripTransactions = (uid, tripId) => readAllPages(() => supabase
  .from('transactions')
  .select(selectFor('transactions', TX_LIST_COLUMNS))
  .eq('user_id', uid)
  .eq('trip_id', tripId)
  .eq('type', 'expense')
  .order('date', { ascending: true })
  .order('id', { ascending: true }));

/** One trip as the API shows it, read fresh after a write. */
async function loadPresentedTrip(uid, tripId) {
  const [trip, stops, budgets, txRaw, today] = await Promise.all([
    readTripRow(uid, tripId),
    readStops(uid, tripId),
    readBudgets(uid, tripId),
    readTripTransactions(uid, tripId),
    todayFor(uid),
  ]);
  const txs = decodeRows('transactions', uid, txRaw);
  return presentTrip(trip, stops, budgets, summariseTrip(trip, stops, budgets, txs, today), today);
}

async function readPrefs(uid) {
  const { data, error } = await supabase
    .from('user_stats')
    .select('currency, special_expenses_enabled')
    .eq('user_id', uid)
    .single();
  if (error) throw error;
  return data;
}

/**
 * A star only counts while Settings → Special expenses is on, so any write that leaves
 * a keep-out trip with it off turns it on (the editor discloses this before saving).
 * Runs before the trip is written: a retry is then harmless, where a failure the other
 * way round would leave a keep-out trip whose stars don't count.
 */
async function turnOnSpecialIfNeeded(uid, keepOut, prefs) {
  if (!keepOut || prefs.special_expenses_enabled) return false;
  const { error } = await supabase
    .from('user_stats')
    .update(encodeWrite('user_stats', uid, { special_expenses_enabled: true }))
    .eq('user_id', uid);
  if (error) throw error;
  return true;
}

/** `lines` is every whole-trip and city line in the save (allCategoryLines). */
async function readOwnedCategories(uid, lines) {
  if (lines.length === 0) return [];
  const { data, error } = await supabase
    .from('categories')
    .select('id, type')
    .in('id', [...new Set(lines.map((b) => b.categoryId))])
    .eq('user_id', uid);
  if (error) throw error;
  return data;
}

/** One stop at a time, because its city lines need the id it gets. A trip has 30 at most. */
async function insertStop(uid, tripId, stop) {
  const { data, error } = await supabase
    .from('trip_stops')
    .insert(encodeWrite('trip_stops', uid, { ...stopRow(stop), user_id: uid, trip_id: tripId }))
    .select('id')
    .single();
  if (error) throw error;
  await insertBudgets(uid, tripId, cityLinesFor(stop, data.id));
}

async function insertBudgets(uid, tripId, rows) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('trip_category_budgets')
    .insert(rows.map((row) => encodeWrite('trip_category_budgets', uid, { ...row, user_id: uid, trip_id: tripId })));
  if (error) throw error;
}

/** The shared half of POST and from-group: everything validated, then trip, then children. */
async function createTrip(uid, body, sourceGroupId = null) {
  const [prefs, owned] = await Promise.all([
    readPrefs(uid),
    readOwnedCategories(uid, allCategoryLines(body)),
  ]);
  const refused = checkTripPlan({ ...body, baseCurrency: prefs.currency })
    ?? checkTripCategories(allCategoryLines(body), owned);
  if (refused) return { refused };

  const specialEnabledNow = await turnOnSpecialIfNeeded(uid, body.keepOutOfMonthly, prefs);

  const { data: created, error } = await supabase
    .from('trips')
    .insert(encodeWrite('trips', uid, {
      user_id: uid,
      name: body.name,
      start_date: body.startDate,
      end_date: body.endDate,
      total_budget: body.totalBudget ?? null,
      keep_out_of_monthly: body.keepOutOfMonthly,
      city_category_budgets: body.cityCategoryBudgets,
      source_group_id: sourceGroupId,
    }))
    .select('id')
    .single();
  if (error) throw error;

  try {
    for (const stop of body.stops) await insertStop(uid, created.id, stop);
    await insertBudgets(uid, created.id, body.categoryBudgets.map((b) => ({
      category_id: b.categoryId,
      amount_limit: b.amount,
    })));
  } catch (err) {
    // Children cascade: no half-made trip for Alex to find.
    await cleanUpTrip(uid, created.id);
    throw err;
  }
  return { tripId: created.id, specialEnabledNow };
}

async function deleteTripRow(uid, id) {
  const { error } = await supabase.from('trips').delete().eq('id', id).eq('user_id', uid);
  if (error) throw error;
}

/** Best effort after a failed create. If it fails too, the orphan must at least show in the logs. */
async function cleanUpTrip(uid, tripId) {
  try {
    await deleteTripRow(uid, tripId);
  } catch (err) {
    console.error('[trips:create] clean-up failed, an empty trip is left behind', {
      userId: uid, tripId, message: err?.message,
    });
  }
}

/**
 * Every trip with its headline figures, from one lean transactions query, so the Trips
 * page, the Dashboard card and Quick Add need no per-trip calls. Paged past the row cap.
 */
router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id;
    // Stops and lines are paged too: city lines can outnumber the database's row cap.
    const [tripsRes, stopRows, budgetRows, txRaw, today] = await Promise.all([
      supabase
        .from('trips')
        .select(selectFor('trips', TRIP_COLUMNS))
        .eq('user_id', uid)
        .order('start_date', { ascending: false })
        .order('created_at', { ascending: true }),
      readAllPages(() => supabase
        .from('trip_stops')
        .select(selectFor('trip_stops', STOP_COLUMNS))
        .eq('user_id', uid)
        .order('start_date', { ascending: true })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })),
      readAllPages(() => supabase
        .from('trip_category_budgets')
        .select(selectFor('trip_category_budgets', BUDGET_COLUMNS))
        .eq('user_id', uid)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })),
      readAllPages(() => supabase
        .from('transactions')
        .select(selectFor('transactions', FIGURE_TX_COLUMNS))
        .eq('user_id', uid)
        .eq('type', 'expense')
        .not('trip_id', 'is', null)
        .order('date', { ascending: true })
        .order('id', { ascending: true })),
      todayFor(uid),
    ]);
    if (tripsRes.error) throw tripsRes.error;

    const stopsByTrip = groupByTrip(decodeRows('trip_stops', uid, stopRows));
    const budgetsByTrip = groupByTrip(decodeRows('trip_category_budgets', uid, budgetRows));
    const txsByTrip = groupByTrip(decodeRows('transactions', uid, txRaw));

    res.json({
      trips: decodeRows('trips', uid, tripsRes.data).map((trip) => {
        const stops = stopsByTrip.get(trip.id) ?? [];
        const budgets = budgetsByTrip.get(trip.id) ?? [];
        const txs = txsByTrip.get(trip.id) ?? [];
        return presentTrip(trip, stops, budgets, summariseTrip(trip, stops, budgets, txs, today), today);
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/from-group', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const parsed = fromGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid trip', details: parsed.error.flatten() });
    }
    const { groupId, trip: body } = parsed.data;

    const { data: group, error: groupErr } = await supabase
      .from('special_groups')
      .select('id')
      .eq('id', groupId)
      .eq('user_id', uid)
      .maybeSingle();
    if (groupErr) throw groupErr;
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const made = await createTrip(uid, body, groupId);
    if (made.refused) return res.status(made.refused.status).json({ error: made.refused.error });

    // One statement, so it either moves them all or moves none. Subscription-linked
    // charges stay in the group: a subscription is home spending, never trip spending.
    const { data: moved, error: moveErr } = await supabase
      .from('transactions')
      .update({ trip_id: made.tripId, special_group_id: null, is_special: body.keepOutOfMonthly })
      .eq('user_id', uid)
      .eq('special_group_id', groupId)
      .eq('type', 'expense')
      .is('recurrence_id', null)
      .select('id');
    if (moveErr) {
      await cleanUpTrip(uid, made.tripId);
      throw moveErr;
    }

    // If only this fails the trip and its expenses stand, and the group stays active
    // and visible until the archive is retried. The panel hides only archived empty groups.
    const { error: archiveErr } = await supabase
      .from('special_groups')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', groupId)
      .eq('user_id', uid);
    if (archiveErr) {
      console.error('[trips:from-group] archive failed', { userId: uid, groupId, message: archiveErr.message });
    }

    res.status(201).json({
      trip: await loadPresentedTrip(uid, made.tripId),
      moved: moved.length,
      groupArchived: !archiveErr,
      specialEnabledNow: made.specialEnabledNow,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = tripCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid trip', details: parsed.error.flatten() });
    }
    const made = await createTrip(req.user.id, parsed.data);
    if (made.refused) return res.status(made.refused.status).json({ error: made.refused.error });
    res.status(201).json({
      trip: await loadPresentedTrip(req.user.id, made.tripId),
      specialEnabledNow: made.specialEnabledNow,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Trip not found' });
    const trip = await readTripRow(uid, id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const [stops, budgets, txRaw, today] = await Promise.all([
      readStops(uid, id),
      readBudgets(uid, id),
      readTripTransactions(uid, id),
      todayFor(uid),
    ]);
    const summary = summariseTrip(trip, stops, budgets, decodeRows('transactions', uid, txRaw), today);

    let sourceGroup = null;
    if (trip.source_group_id) {
      const { data: group, error } = await supabase
        .from('special_groups')
        .select(selectFor('special_groups', 'id, name'))
        .eq('id', trip.source_group_id)
        .eq('user_id', uid)
        .maybeSingle();
      if (error) throw error;
      if (group) {
        const decoded = decodeRow('special_groups', uid, group);
        sourceGroup = { id: decoded.id, name: decoded.name };
      }
    }

    res.json({
      trip: presentTrip(trip, stops, budgets, summary, today),
      summary,
      sourceGroup,
      transactions: presentRows('transactions', uid, txRaw, TX_LIST_COLUMNS),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The editor's single save. Everything is validated together with the new dates, so
 * postponing a trip with its stops just works. Then: deletes, updates, inserts, the
 * transactions, and the trip row LAST, so a keep-out flip that fails part-way leaves the
 * old value stored and a retry re-applies it.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Trip not found' });
    const parsed = tripPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    const trip = await readTripRow(uid, id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const [existingStops, existingBudgets, prefs, owned] = await Promise.all([
      readStops(uid, id),
      readBudgets(uid, id),
      readPrefs(uid),
      readOwnedCategories(uid, allCategoryLines(body)),
    ]);

    const startDate = body.startDate ?? trip.start_date;
    const endDate = body.endDate ?? trip.end_date;
    const desiredStops = body.stops ?? existingStops.map((s) => ({
      name: s.name, startDate: s.start_date, endDate: s.end_date,
    }));
    const refused = checkTripPlan({
      startDate,
      endDate,
      stops: desiredStops,
      categoryBudgets: body.categoryBudgets ?? [],
      baseCurrency: body.stops ? prefs.currency : null,
    }) ?? checkTripCategories(allCategoryLines(body), owned);
    if (refused) return res.status(refused.status).json({ error: refused.error });

    const stopDiff = body.stops ? diffStops(existingStops, body.stops) : null;
    if (stopDiff?.error) return res.status(stopDiff.status).json({ error: stopDiff.error });
    const budgetDiff = body.categoryBudgets ? diffCategoryBudgets(existingBudgets, body.categoryBudgets) : null;
    const cityDiff = body.stops ? diffCityBudgets(existingBudgets, body.stops) : null;

    const keepOut = body.keepOutOfMonthly ?? trip.keep_out_of_monthly;
    const specialEnabledNow = await turnOnSpecialIfNeeded(uid, keepOut, prefs);

    if (stopDiff?.removedIds.length) {
      // The database cascades these, but only once the stop goes; deleting them first keeps
      // the order the same everywhere, including the test database, which has no cascade.
      const { error: linesErr } = await supabase
        .from('trip_category_budgets')
        .delete()
        .in('stop_id', stopDiff.removedIds)
        .eq('trip_id', id)
        .eq('user_id', uid);
      if (linesErr) throw linesErr;
      // Overrides next, so a tagged expense goes back to deriving its city.
      const { error: overrideErr } = await supabase
        .from('transactions')
        .update({ trip_stop_id: null })
        .eq('user_id', uid)
        .eq('trip_id', id)
        .in('trip_stop_id', stopDiff.removedIds);
      if (overrideErr) throw overrideErr;
      const { error } = await supabase
        .from('trip_stops')
        .delete()
        .in('id', stopDiff.removedIds)
        .eq('trip_id', id)
        .eq('user_id', uid);
      if (error) throw error;
    }
    if (budgetDiff?.removedCategoryIds.length) {
      const { error } = await supabase
        .from('trip_category_budgets')
        .delete()
        .in('category_id', budgetDiff.removedCategoryIds)
        // Whole-trip lines only: without this, removing Food from the trip would also
        // remove every city's Food line.
        .is('stop_id', null)
        .eq('trip_id', id)
        .eq('user_id', uid);
      if (error) throw error;
    }
    if (cityDiff?.removedIds.length) {
      const { error } = await supabase
        .from('trip_category_budgets')
        .delete()
        .in('id', cityDiff.removedIds)
        .eq('trip_id', id)
        .eq('user_id', uid);
      if (error) throw error;
    }

    for (const { id: stopId, row } of stopDiff?.toUpdate ?? []) {
      // stopRow carries name AND budget, so every encrypted field is written together
      // (the backfill treats a row as done once its first _enc column is set).
      const { error } = await supabase
        .from('trip_stops')
        .update(encodeWrite('trip_stops', uid, row))
        .eq('id', stopId)
        .eq('trip_id', id)
        .eq('user_id', uid);
      if (error) throw error;
    }
    for (const { id: budgetId, amount_limit } of [...(budgetDiff?.toUpdate ?? []), ...(cityDiff?.toUpdate ?? [])]) {
      const { error } = await supabase
        .from('trip_category_budgets')
        .update(encodeWrite('trip_category_budgets', uid, { amount_limit }))
        .eq('id', budgetId)
        .eq('trip_id', id)
        .eq('user_id', uid);
      if (error) throw error;
    }

    for (const stop of (body.stops ?? []).filter((s) => !s.id)) await insertStop(uid, id, stop);
    await insertBudgets(uid, id, [...(budgetDiff?.toInsert ?? []), ...(cityDiff?.toInsert ?? [])]);

    if (body.keepOutOfMonthly !== undefined && body.keepOutOfMonthly !== trip.keep_out_of_monthly) {
      const { error } = await supabase
        .from('transactions')
        .update({ is_special: body.keepOutOfMonthly })
        .eq('user_id', uid)
        .eq('trip_id', id)
        .eq('type', 'expense');
      if (error) throw error;
    }

    const payload = {};
    if (body.startDate !== undefined) payload.start_date = body.startDate;
    if (body.endDate !== undefined) payload.end_date = body.endDate;
    if (body.keepOutOfMonthly !== undefined) payload.keep_out_of_monthly = body.keepOutOfMonthly;
    if (body.cityCategoryBudgets !== undefined) payload.city_category_budgets = body.cityCategoryBudgets;
    if (body.archived !== undefined) payload.archived_at = body.archived ? new Date().toISOString() : null;
    if (body.name !== undefined || body.totalBudget !== undefined) {
      // Every encrypted field whenever either changes, for the same backfill reason.
      payload.name = body.name ?? trip.name;
      payload.total_budget = body.totalBudget !== undefined ? body.totalBudget : trip.total_budget;
    }
    if (Object.keys(payload).length > 0) {
      const { error } = await supabase
        .from('trips')
        .update(encodeWrite('trips', uid, payload))
        .eq('id', id)
        .eq('user_id', uid);
      if (error) throw error;
    }

    res.json({ trip: await loadPresentedTrip(uid, id), specialEnabledNow });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE never deletes spending. Each mode handles the expenses in ONE statement that
 * also nulls the trip, so it can't break the trip-XOR-group CHECK partway. Only after
 * that succeeds does the group come back and the trip go.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Trip not found' });
    const mode = req.query.expenses;
    if (!DELETE_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Say what should happen to its expenses' });
    }

    const trip = await readTripRow(uid, id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const update = { trip_id: null, trip_stop_id: null };
    if (mode === 'count') update.is_special = false;
    if (mode === 'restore') {
      const { data: group, error: groupErr } = trip.source_group_id
        ? await supabase
          .from('special_groups')
          .select('id')
          .eq('id', trip.source_group_id)
          .eq('user_id', uid)
          .maybeSingle()
        : { data: null, error: null };
      if (groupErr) throw groupErr;
      if (!group) return res.status(409).json({ error: 'The group this trip came from no longer exists' });
      update.special_group_id = group.id;
      update.is_special = true;
    }

    const { error: txErr } = await supabase
      .from('transactions')
      .update(update)
      .eq('user_id', uid)
      .eq('trip_id', id);
    if (txErr) throw txErr;

    if (mode === 'restore') {
      const { error } = await supabase
        .from('special_groups')
        .update({ archived_at: null })
        .eq('id', update.special_group_id)
        .eq('user_id', uid);
      if (error) throw error;
    }

    await deleteTripRow(uid, id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * "Add expenses": no trip, no group, not a subscription or Repeat-this charge (those are
 * home spending). Read by date window and paged BEFORE `q`, because `q` can only be
 * applied to decoded text.
 */
router.get('/:id/untagged', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Trip not found' });
    const trip = await readTripRow(uid, id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const raw = await readAllPages(() => supabase
      .from('transactions')
      .select(selectFor('transactions', UNTAGGED_COLUMNS))
      .eq('user_id', uid)
      .eq('type', 'expense')
      .is('trip_id', null)
      .is('special_group_id', null)
      .is('recurrence_id', null)
      .gte('date', untaggedWindowStart(trip))
      .lte('date', trip.end_date)
      .order('date', { ascending: true })
      .order('id', { ascending: true }));

    const { during, before } = splitUntagged(decodeRows('transactions', uid, raw), trip, req.query.q);
    const present = (rows) => rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      date: r.date,
      description: r.description ?? null,
      category_id: r.category_id,
      original_amount: r.original_amount == null ? null : Number(r.original_amount),
      original_currency: r.original_currency ?? null,
    }));
    res.json({ during: present(during), before: present(before) });
  } catch (err) {
    next(err);
  }
});

/**
 * Bulk add. One conditional statement, so it either applies or it doesn't and a retry
 * is safe. No city writes, because cities are derived. The filters skip other users'
 * rows, income, and anything already on a trip, in a group or linked to a subscription.
 */
router.post('/:id/transactions', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Trip not found' });
    const parsed = bulkAddSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid selection', details: parsed.error.flatten() });
    }
    const trip = await readTripRow(uid, id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    // Keep-out off leaves each star as it was, the same as every other way of joining.
    const update = trip.keep_out_of_monthly ? { trip_id: id, is_special: true } : { trip_id: id };
    const { data, error } = await supabase
      .from('transactions')
      .update(update)
      .in('id', parsed.data.transactionIds)
      .eq('user_id', uid)
      .eq('type', 'expense')
      .is('trip_id', null)
      .is('special_group_id', null)
      .is('recurrence_id', null)
      .select('id');
    if (error) throw error;
    res.json({ added: data.length });
  } catch (err) {
    next(err);
  }
});

export default router;
