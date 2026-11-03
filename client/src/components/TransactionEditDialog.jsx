import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { BadgeCheck, Repeat, Star } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MoneyInput, isValidMoney, sanitizeMoneyInput } from '@/components/ui/money-input';
import { SpecialGroupPicker } from '@/components/SpecialGroupPicker';
import { TripPicker } from '@/components/TripPicker';
import { CurrencyPicker, ConversionLine } from '@/components/CurrencyEntry';
import { Label } from '@/components/ui/label';
import { useApi } from '@/hooks/useApi';
import { useTrips } from '@/hooks/useTrips';
import { invalidateMoney } from '@/lib/invalidate';
import { starAfterTripChange, stopFieldFor, stopForDate } from '@/lib/trips';
import { SubscriptionMarker } from '@/components/SubscriptionMarker';
import { subscriptionLabel } from '@/lib/subscriptions';
import {
  runSubscriptionAction,
  subscriptionActionMessage,
  isActionReady,
  allowsSave,
} from '@/lib/subscriptionActions';

/**
 * The Edit dialog, shared by Transactions and a trip's page, with its own save. `tx`
 * must be a SNAPSHOT of the row (held in the parent's state), not a row derived from
 * query data: the reset effect below is keyed on it, so a refetch would wipe the form
 * (BUGS-FIXED shape 8).
 */
export function TransactionEditDialog({
  tx,
  open,
  onOpenChange,
  specialEnabled = false,
  currency = 'GBP',
}) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isSpecial, setIsSpecial] = useState(false);
  const [specialGroupId, setSpecialGroupId] = useState(null);
  // Phase 12b — a mis-picked currency used to mean delete-and-re-add.
  const [entryCurrency, setEntryCurrency] = useState(currency);
  const [rate, setRate] = useState('1');
  const [rateState, setRateState] = useState('idle');
  // Phase 17 — the Subscription section. Applied by Save, after the field edits.
  const [markOpen, setMarkOpen] = useState(false);
  const [subAction, setSubAction] = useState(null);
  const [detach, setDetach] = useState(false);
  // Phase 18 — the trip. "Touched" is this visit only, so re-saving a typo fix can never
  // re-derive (and silently flip) a hand-set star.
  const [tripId, setTripId] = useState(null);
  const [stopChoice, setStopChoice] = useState(null);
  const [tripTouched, setTripTouched] = useState(false);
  const [specialTouched, setSpecialTouched] = useState(false);
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: tripsData } = useTrips();
  const trips = tripsData?.trips ?? [];
  const { data: catsData } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
    enabled: open,
  });
  const categories = catsData?.categories ?? [];

  // Phase 17: Save PATCHes the fields exactly as before, THEN applies the
  // Subscription section's action. If that second step fails, the edit is already
  // saved, so the dialog stays open and says so plainly.
  const updateMutation = useMutation({
    mutationFn: async ({ id, payload, subAction: action }) => {
      await api.patch(`/api/transactions/${id}`, payload);
      if (!action) return { action: null };
      try {
        const result = await runSubscriptionAction(api, id, action);
        return { action, result };
      } catch (subError) {
        return { action, subError };
      }
    },
    onSuccess: ({ action, result, subError }) => {
      invalidateMoney(queryClient);
      if (subError) {
        if (subError.status === 409 && subError.body?.existing) {
          // The Subscription section re-asks the server and now shows the offer.
          toast('You already track this one', { description: 'Pick an option in the Subscription section.' });
        } else if (subError.status === 409 && subError.body?.repeating) {
          // The server's message carries the specific reason (and what to do).
          toast(subError.message || 'Trim already logs this automatically');
        } else {
          const what = action.type === 'attach'
            ? `add it to ${action.label}`
            : action.type === 'detach'
              ? `remove it from ${action.label}`
              : 'mark it as a subscription';
          toast.error(`Saved — but couldn't ${what}. Try again.`);
        }
        return;
      }
      if (action) {
        const m = subscriptionActionMessage(action, result);
        toast.success(m.title, { description: m.description });
      } else {
        toast.success('Updated');
      }
      onOpenChange(false);
    },
    onError: (err) => toast.error(err?.message || 'Could not update'),
  });
  const saving = updateMutation.isPending;

  // "Part of Netflix": the name comes from the Subscriptions list.
  const linkedKey = tx?.recurrence_id ? `manual:${tx.recurrence_id}` : null;
  const { data: subsData } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api.get('/api/subscriptions'),
    enabled: open && !!linkedKey,
  });
  const linkedSub = (subsData?.subscriptions ?? []).find((x) => x.merchantKey === linkedKey) ?? null;
  const linkedLabel = linkedSub ? subscriptionLabel(linkedSub, currency) : 'a subscription you marked';

  useEffect(() => {
    if (!tx || !open) return;
    setMarkOpen(false);
    setSubAction(null);
    setDetach(false);
    // Seed from the row's own currency, so opening an existing euro expense
    // shows euros and its stored rate rather than silently reverting to base.
    const wasForeign = !!tx.original_currency;
    setAmount(
      sanitizeMoneyInput(
        String(wasForeign ? tx.original_amount : tx.amount),
        wasForeign ? tx.original_currency : currency,
      ),
    );
    setEntryCurrency(wasForeign ? tx.original_currency : currency);
    setRate(wasForeign ? String(tx.fx_rate) : '1');
    setRateState(wasForeign ? 'ready' : 'idle');
    setDescription(tx.description ?? '');
    setDate(tx.date);
    setCategoryId(tx.category_id);
    setIsSpecial(!!tx.is_special);
    setSpecialGroupId(tx.special_group_id ?? null);
    setTripId(tx.trip_id ?? null);
    setStopChoice(tx.trip_stop_id ?? null);
    setTripTouched(false);
    setSpecialTouched(false);
  }, [tx, open, currency]);

  const isForeign = entryCurrency !== currency;

  // Only fetch when the user CHANGES currency — never on open, which would
  // overwrite the rate this transaction was actually created at.
  const [rateDirty, setRateDirty] = useState(false);
  // On close, not on open: the rate effect below runs in the same commit as the reset
  // above, so a flag left set by the last visit would refetch the next row's rate,
  // overwriting the rate that expense was actually logged at.
  useEffect(() => {
    if (!open) setRateDirty(false);
  }, [open]);
  useEffect(() => {
    if (!open || !rateDirty || !isForeign) return;
    let cancelled = false;
    setRateState('loading');
    setRate('');
    api
      .get(`/api/fx?from=${entryCurrency}&to=${currency}`)
      .then((r) => {
        if (cancelled) return;
        if (r && typeof r.rate === 'number' && r.rate > 0) {
          setRate(String(r.rate));
          setRateState('ready');
        } else setRateState('unavailable');
      })
      .catch(() => {
        if (!cancelled) setRateState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [open, rateDirty, isForeign, entryCurrency, currency, api]);

  if (!tx) return null;
  const amountNum = Number(amount);
  // Same gate as Quick Add: a foreign edit without a usable rate must not save,
  // or the foreign figure would be stored as base currency.
  const fxRate = Number(rate);
  const rateValid = !isForeign || (rate !== '' && Number.isFinite(fxRate) && fxRate > 0);
  const sameTypeCats = categories.filter((c) => c.type === tx.type);
  const storedTripId = tx.trip_id ?? null;
  const selectedTrip = trips.find((t) => t.id === tripId) ?? null;

  // Handlers, not effects, so nothing resets when trip data refetches.
  function chooseTrip(next) {
    setTripId(next);
    setTripTouched(true);
    setStopChoice(next === storedTripId ? tx.trip_stop_id ?? null : null);
    // Undoing the pick gives the group back, or Save would drop the row out of a group
    // it never meant to leave.
    if (next) setSpecialGroupId(null);
    else if (next === storedTripId) setSpecialGroupId(tx.special_group_id ?? null);
    if (!specialTouched) {
      setIsSpecial(starAfterTripChange({
        storedTripId, nextTripId: next, storedSpecial: tx.is_special, trips,
      }));
    }
  }

  // Attaching would take the trip straight back off, so a trip choice can't stand.
  function openMarker() {
    setMarkOpen(true);
    if (tripTouched) chooseTrip(storedTripId);
    setTripTouched(false);
  }

  function tripPayload() {
    const changed = tripTouched && tripId !== storedTripId;
    return {
      ...(changed ? { tripId } : {}),
      ...stopFieldFor({
        storedTripId,
        storedStopId: tx.trip_stop_id,
        nextTripId: tripId,
        choice: stopChoice,
        derivedId: stopForDate(selectedTrip?.stops ?? [], date)?.id ?? null,
      }),
    };
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit transaction</DialogTitle>
          <DialogDescription>
            {tx.type === 'expense' ? 'Expense' : 'Income'} · adjust any field and save.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-end justify-between gap-2">
              <Label htmlFor="edit-amount">Amount</Label>
              <CurrencyPicker
                value={entryCurrency}
                base={currency}
                onChange={(c) => {
                  setEntryCurrency(c);
                  setRateDirty(true);
                  if (c === currency) {
                    setRate('1');
                    setRateState('idle');
                  }
                }}
              />
            </div>
            <MoneyInput
              id="edit-amount"
              currency={entryCurrency}
              value={amount}
              onValueChange={setAmount}
              className="no-spin"
            />
            {isForeign ? (
              <ConversionLine
                amountStr={amount}
                entryCurrency={entryCurrency}
                baseCurrency={currency}
                rate={rate}
                rateState={rateState}
                onRateChange={setRate}
              />
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sameTypeCats.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="mr-2">{c.icon}</span>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-date">Date</Label>
            <Input id="edit-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-desc">Note</Label>
            <Input
              id="edit-desc"
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {specialEnabled && tx.type === 'expense' ? (
            <label className="flex items-center justify-between rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <Star className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
                Special expense
                <span className="text-xs text-muted-foreground">kept out of your monthly budget</span>
              </span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={isSpecial}
                onChange={(e) => {
                  setIsSpecial(e.target.checked);
                  setSpecialTouched(true);
                  if (!e.target.checked) setSpecialGroupId(null);
                }}
              />
            </label>
          ) : null}

          {/* Phase 10 B1 — same optional grouping as Quick-Add. */}
          {specialEnabled && tx.type === 'expense' && isSpecial && !tripId ? (
            <SpecialGroupPicker
              value={specialGroupId}
              onChange={setSpecialGroupId}
              className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2"
            />
          ) : null}

          {/* Phase 18. It never changes the currency: this dialog only fetches a rate
              when Alex changes currency, so seeding one here would store a foreign
              amount at rate 1 (the Phase 12 bug class). */}
          {tx.type === 'expense' ? (
            <TripPicker
              tripId={tripId}
              stopId={stopChoice}
              date={date}
              includeTripId={storedTripId}
              onTripChange={chooseTrip}
              onStopChange={setStopChoice}
              disabledReason={
                tx.recurrence_id
                  ? 'A subscription is home spending, so it can’t go on a trip.'
                  : markOpen
                    ? 'Marking this as a subscription takes it off any trip.'
                    : null
              }
            />
          ) : null}

          {/* Phase 17 — mark it yourself, instead of waiting for three charges. */}
          {tx.type === 'expense' ? (
            <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                <BadgeCheck className="h-4 w-4 text-primary" aria-hidden />
                Subscription
              </p>
              {/* A Repeat-this row whose schedule was deleted has is_recurring but no
                  recurrence_id: nothing manages it any more, so it can be marked (and
                  marking clears is_recurring, so a tracked charge never lands here). */}
              {tx.is_recurring && tx.recurrence_id ? (
                <p className="text-xs text-muted-foreground">
                  Logged automatically by a repeating schedule —{' '}
                  <Link to="/subscriptions" className="font-medium text-primary hover:underline">manage it on Subscriptions</Link>.
                </p>
              ) : tx.recurrence_id ? (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    Part of <span className="font-medium">{linkedLabel}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    Remove from it
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={detach}
                      onChange={(e) => setDetach(e.target.checked)}
                    />
                  </span>
                </label>
              ) : markOpen ? (
                <>
                  <SubscriptionMarker
                    transactionId={tx.id}
                    currency={currency}
                    values={{
                      description: description.trim(),
                      categoryId,
                      // The matcher compares home-currency amounts; a foreign entry's
                      // field holds the original, so convert it the way Save will.
                      amount: isForeign ? amountNum * Number(rate) : amountNum,
                      date,
                    }}
                    onActionChange={setSubAction}
                    onTrip={!!tx.trip_id}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setMarkOpen(false);
                      setSubAction(null);
                    }}
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Not a subscription
                  </button>
                </>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={openMarker}>
                  <Repeat className="h-3.5 w-3.5" aria-hidden />
                  This is a subscription
                </Button>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              updateMutation.mutate({ id: tx.id, payload: {
                amount: amountNum,
                categoryId,
                date,
                description: description.trim() || null,
                // Only when changed in this visit, so a hand-set star survives a typo fix.
                ...(tx.type === 'expense' && specialTouched ? { isSpecial } : {}),
                // While a trip is chosen the server clears any group.
                ...(tx.type === 'expense' && isSpecial && !tripId ? { specialGroupId } : {}),
                ...(tx.type === 'expense' ? tripPayload() : {}),
                // Send the block when foreign; send null to convert a row back
                // to plain base currency; omit entirely if it was never foreign.
                ...(isForeign
                  ? {
                      foreign: {
                        originalAmount: amountNum,
                        originalCurrency: entryCurrency,
                        fxRate: Number(rate),
                      },
                    }
                  : tx.original_currency
                    ? { foreign: null }
                    : {}),
              }, subAction: detach
                ? { type: 'detach', merchantKey: linkedKey, label: linkedLabel }
                : markOpen && isActionReady(subAction) ? subAction : null })
            }
            disabled={
              saving || !isValidMoney(amount) || !categoryId || !date || !rateValid
              || (markOpen && !allowsSave(subAction))
            }
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
