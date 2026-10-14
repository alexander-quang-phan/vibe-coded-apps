import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SubscriptionMarker } from '@/components/SubscriptionMarker';
import { useApi } from '@/hooks/useApi';
import { formatMoney, formatDate } from '@/lib/format';
import { invalidateMoney } from '@/lib/invalidate';
import {
  runSubscriptionAction,
  subscriptionActionMessage,
  isActionReady,
} from '@/lib/subscriptionActions';

/**
 * Subscriptions → "Add a subscription" (Phase 17).
 *
 * Step 1: pick one of your unlinked expenses from the last 13 months (searchable —
 * long enough to reach a yearly charge). Step 2: the same marking panel as the
 * Transactions edit dialog, then "Track it" / "Add it".
 */
export function AddSubscriptionDialog({ open, onOpenChange, currency, onDetected }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [picked, setPicked] = useState(null);
  const [action, setAction] = useState(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setDebouncedQuery('');
    setPicked(null);
    setAction(null);
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isLoading } = useQuery({
    queryKey: ['subscriptions', 'recent', debouncedQuery],
    queryFn: () =>
      api.get(`/api/subscriptions/track/recent${debouncedQuery ? `?q=${encodeURIComponent(debouncedQuery)}` : ''}`),
    enabled: open && !picked,
  });
  const { data: catsData } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
    enabled: open,
  });
  const catName = (id) => (catsData?.categories ?? []).find((c) => c.id === id)?.name ?? 'Expense';

  const mutation = useMutation({
    mutationFn: () => runSubscriptionAction(api, picked.id, action),
    onSuccess: () => {
      invalidateMoney(queryClient);
      const m = subscriptionActionMessage(action);
      toast.success(m.title, { description: m.description });
      onOpenChange(false);
    },
    onError: (err) => {
      invalidateMoney(queryClient); // the marking panel re-asks and shows the offer
      if (err?.status === 409 && err?.body?.existing) {
        toast('You already track this one', { description: 'Choose “Add to …” instead.' });
      } else if (err?.status === 409 && err?.body?.repeating) {
        toast('Trim already logs this automatically', { description: 'It is already on this page.' });
      } else {
        toast.error(err?.message || "Couldn't save the subscription");
      }
    },
  });

  const rows = data?.transactions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a subscription</DialogTitle>
          <DialogDescription>
            {picked ? 'Tell Trim what this charge is.' : 'Pick a charge you already logged — it shows up straight away.'}
          </DialogDescription>
        </DialogHeader>

        {!picked ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Search note or category"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
              </div>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {debouncedQuery ? 'Nothing matches that — try another word.' : 'No unlinked expenses in the last 13 months.'}
              </p>
            ) : (
              <div className="divide-y divide-border/60 rounded-lg border border-border/60">
                {rows.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setPicked(t)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{t.description || catName(t.categoryId)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {catName(t.categoryId)} · {formatDate(t.date)}
                      </span>
                    </span>
                    <span className="nums text-sm font-semibold">{formatMoney(t.amount, currency)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setAction(null);
              }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Pick a different charge
            </button>
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-secondary/30 px-3 py-2 text-sm">
              <span className="min-w-0 truncate font-medium">{picked.description || catName(picked.categoryId)}</span>
              <span className="nums">{formatMoney(picked.amount, currency)} · {formatDate(picked.date)}</span>
            </div>
            <SubscriptionMarker
              transactionId={picked.id}
              currency={currency}
              onActionChange={setAction}
              noteEditable={false}
              onChangeNote={() => {
                onOpenChange(false);
                navigate(`/transactions?month=${picked.date.slice(0, 7)}&edit=${picked.id}`);
              }}
              onDetected={(det) => {
                onOpenChange(false);
                onDetected?.(det.merchantKey);
              }}
            />
          </div>
        )}

        {picked ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button onClick={() => mutation.mutate()} disabled={!isActionReady(action) || mutation.isPending}>
              {mutation.isPending ? 'Saving…' : action?.type === 'attach' ? 'Add it' : 'Track it'}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
