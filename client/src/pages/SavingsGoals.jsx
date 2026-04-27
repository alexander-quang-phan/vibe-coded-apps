import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, PiggyBank } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/format';
import { celebrateGoalCompleted, celebrateGoalMilestone } from '@/lib/confetti';

const EMOJI_CHOICES = ['🏠', '✈️', '💻', '🎓', '🚗', '💍', '🎮', '📱', '🏖️', '🎁', '💰', '🎸'];

function GoalCard({ goal, currency, onEdit, onDelete, onContribute }) {
  const percent = Math.round(goal.percent * 100);
  const remaining = Math.max(goal.targetAmount - goal.currentAmount, 0);

  return (
    <Card className="lift relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
      {/* Soft glow that brightens as you near 100% */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-12 h-44 w-44 rounded-full blur-3xl"
        style={{
          background: goal.completed
            ? 'radial-gradient(closest-side, hsl(var(--gold) / 0.35), transparent)'
            : `radial-gradient(closest-side, hsl(var(--primary) / ${0.12 + percent / 400}), transparent)`,
        }}
      />
      <CardContent className="relative space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-secondary to-secondary/40 text-2xl ring-1 ring-border/60">
              {goal.emoji || '🎯'}
            </span>
            <div>
              <h3 className="font-semibold leading-tight">{goal.name}</h3>
              {goal.targetDate ? (
                <p className="text-xs text-muted-foreground">
                  by{' '}
                  {new Date(`${goal.targetDate}T00:00:00`).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">No deadline</p>
              )}
            </div>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={() => onEdit(goal)} aria-label="Edit goal">
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => onDelete(goal)} aria-label="Delete goal">
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <span className="nums text-2xl font-bold tracking-tight">
              {formatMoney(goal.currentAmount, currency)}
            </span>
            <span className="nums text-sm text-muted-foreground">
              of {formatMoney(goal.targetAmount, currency)}
            </span>
          </div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted/70">
            <div
              className="shimmer-bar h-full rounded-full transition-all duration-700"
              style={{
                width: `${percent}%`,
                background: goal.completed
                  ? 'linear-gradient(90deg, hsl(var(--gold)) 0%, hsl(var(--primary)) 100%)'
                  : 'linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.85) 60%, hsl(var(--gold) / 0.95) 100%)',
              }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="nums rounded-full bg-primary/15 px-2 py-0.5 font-semibold text-primary">
              {percent}%
            </span>
            <span className="nums text-muted-foreground">
              {goal.completed ? 'Complete! 🎉' : `${formatMoney(remaining, currency)} to go`}
            </span>
          </div>
        </div>

        {!goal.completed ? (
          <Button
            variant="outline"
            className="w-full border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
            onClick={() => onContribute(goal)}
          >
            <PiggyBank className="h-4 w-4" /> Add money
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function GoalDialog({ open, onOpenChange, editing, onSubmit, submitting }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🎯');
  const [target, setTarget] = useState('');
  const [date, setDate] = useState('');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setEmoji(editing.emoji || '🎯');
      setTarget(String(editing.targetAmount));
      setDate(editing.targetDate ?? '');
    } else {
      setName('');
      setEmoji('🎯');
      setTarget('');
      setDate('');
    }
  }, [editing, open]);

  const targetNum = Number(target);
  const canSubmit = name.trim() && Number.isFinite(targetNum) && targetNum > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit goal' : 'New savings goal'}</DialogTitle>
          <DialogDescription>
            Give it a name, a target, and optionally a deadline. You'll celebrate every 25%.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1.5">
              {EMOJI_CHOICES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  className={`flex h-10 w-10 items-center justify-center rounded-lg border text-xl transition ${
                    emoji === e
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-secondary/40 hover:bg-accent'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-name">Name</Label>
            <Input
              id="goal-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Emergency fund"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-target">Target amount</Label>
            <Input
              id="goal-target"
              type="number"
              step="0.01"
              min="0"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="0.00"
              className="no-spin"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-date">Target date (optional)</Label>
            <Input
              id="goal-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                name: name.trim(),
                emoji,
                targetAmount: targetNum,
                targetDate: date || null,
              })
            }
            disabled={!canSubmit || submitting}
          >
            {submitting ? 'Saving…' : editing ? 'Save' : 'Create goal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContributeDialog({ open, onOpenChange, goal, onSubmit, submitting, currency }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setAmount('');
    setNote('');
  }, [open]);

  if (!goal) return null;
  const amountNum = Number(amount);
  const canSubmit = Number.isFinite(amountNum) && amountNum > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to {goal.name}</DialogTitle>
          <DialogDescription>
            You're at {formatMoney(goal.currentAmount, currency)} of{' '}
            {formatMoney(goal.targetAmount, currency)}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="contrib-amount">Amount</Label>
            <Input
              id="contrib-amount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="no-spin"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contrib-note">Note (optional)</Label>
            <Input
              id="contrib-note"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit({ amount: amountNum, note: note.trim() || null })}
            disabled={!canSubmit || submitting}
          >
            {submitting ? 'Saving…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SavingsGoals() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [goalOpen, setGoalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [contributingGoal, setContributingGoal] = useState(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['goals'],
    queryFn: () => api.get('/api/goals'),
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });
  const currency = me?.preferences?.currency ?? 'GBP';

  const createMutation = useMutation({
    mutationFn: (payload) => api.post('/api/goals', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      toast.success('Goal created');
      setGoalOpen(false);
    },
    onError: (err) => toast.error(err?.message || 'Could not create goal'),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => api.patch(`/api/goals/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      toast.success('Goal updated');
      setGoalOpen(false);
      setEditing(null);
    },
    onError: (err) => toast.error(err?.message || 'Could not update'),
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => api.del(`/api/goals/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      toast.success('Goal removed');
    },
    onError: (err) => toast.error(err?.message || 'Could not delete'),
  });
  const contribMutation = useMutation({
    mutationFn: ({ id, payload }) => api.post(`/api/goals/${id}/contributions`, payload),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      queryClient.invalidateQueries({ queryKey: ['wins'] });
      setContributingGoal(null);
      if (res.justCompleted) {
        celebrateGoalCompleted();
        toast.success(`${res.goal.name} — done! 🎉`, { description: "Unbelievable. That's a full goal." });
      } else if (res.milestone) {
        celebrateGoalMilestone();
        const pct = Math.round(res.milestone * 100);
        toast.success(`${pct}% of the way there!`, { description: `Keep going with ${res.goal.name}.` });
      } else {
        toast.success('Nice — added.');
      }
    },
    onError: (err) => toast.error(err?.message || 'Could not add'),
  });

  function handleGoalSubmit(payload) {
    if (editing) updateMutation.mutate({ id: editing.id, payload });
    else createMutation.mutate(payload);
  }

  const goals = data?.goals ?? [];

  return (
    <div className="space-y-5 pb-12 animate-fade-up">
      <header className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Save on purpose. Watch it grow.</p>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Savings goals</h1>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setGoalOpen(true);
          }}
          className="bg-gradient-to-br from-primary to-emerald-700 shadow-md shadow-primary/30 transition-transform hover:scale-[1.02]"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New goal</span>
        </Button>
      </header>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-52" />
          ))}
        </div>
      ) : isError ? (
        <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm font-medium">Couldn't load goals.</p>
          <p className="text-xs text-muted-foreground">{error?.message}</p>
          <button onClick={() => refetch()} className="text-sm font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      ) : goals.length === 0 ? (
        <Card className="relative overflow-hidden border-border/60 bg-card/70 backdrop-blur">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-20 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
          />
          <CardContent className="relative flex flex-col items-center gap-3 p-10 text-center">
            <span className="text-5xl animate-float-slow" aria-hidden>
              🎯
            </span>
            <div className="space-y-1">
              <p className="font-semibold">No goals yet</p>
              <p className="text-sm text-muted-foreground">
                Pick something to save toward — a trip, an emergency fund, a new laptop.
              </p>
            </div>
            <Button
              onClick={() => {
                setEditing(null);
                setGoalOpen(true);
              }}
              className="bg-gradient-to-br from-primary to-emerald-700 shadow-md shadow-primary/30"
            >
              <Plus className="h-4 w-4" /> Create your first goal
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              currency={currency}
              onEdit={(x) => {
                setEditing(x);
                setGoalOpen(true);
              }}
              onDelete={(x) => {
                if (confirm(`Delete "${x.name}"? Contributions will also be removed.`)) {
                  deleteMutation.mutate(x.id);
                }
              }}
              onContribute={setContributingGoal}
            />
          ))}
        </div>
      )}

      <GoalDialog
        open={goalOpen}
        onOpenChange={(v) => {
          setGoalOpen(v);
          if (!v) setEditing(null);
        }}
        editing={editing}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleGoalSubmit}
      />
      <ContributeDialog
        open={!!contributingGoal}
        onOpenChange={(v) => !v && setContributingGoal(null)}
        goal={contributingGoal}
        currency={currency}
        submitting={contribMutation.isPending}
        onSubmit={(payload) =>
          contribMutation.mutate({ id: contributingGoal.id, payload })
        }
      />
    </div>
  );
}
