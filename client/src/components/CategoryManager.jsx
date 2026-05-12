import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
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
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentGroup, SegmentButton } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/useApi';
import { cn } from '@/lib/utils';

const CATEGORY_EMOJI_CHOICES = [
  '🍔', '🛒', '🚗', '🏠', '💡', '🎬', '🛍️', '💊',
  '💼', '💻', '🎓', '✈️', '☕', '🍺', '🎁', '💰',
  '🐾', '⛽', '🏥', '📦',
];

// Curated 10-swatch palette matching Tailwind 500 shades — chosen to look good
// against the dark theme and play nicely with the seeded category colours.
const COLOR_CHOICES = [
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
];

const PROTECTED_DEFAULT_NAMES = new Set(['Other', 'Other Income']);

function isProtected(cat) {
  return cat.is_default && PROTECTED_DEFAULT_NAMES.has(cat.name);
}

function CategoryDialog({ open, onOpenChange, editing, onSubmit, submitting }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('📦');
  const [color, setColor] = useState('#64748b');
  const [type, setType] = useState('expense');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setIcon(editing.icon || '📦');
      setColor(editing.color || '#64748b');
      setType(editing.type);
    } else {
      setName('');
      setIcon('📦');
      setColor(COLOR_CHOICES[5]);
      setType('expense');
    }
  }, [editing, open]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= 40;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Tweak the name, icon, or colour. Type stays the same.'
              : 'Pick a name, an icon, and a colour. Spending or earning?'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Coffee"
              autoFocus
            />
          </div>

          {!editing ? (
            <div className="space-y-1.5">
              <Label>Type</Label>
              <SegmentGroup>
                <SegmentButton active={type === 'expense'} onClick={() => setType('expense')}>
                  Spending
                </SegmentButton>
                <SegmentButton active={type === 'income'} onClick={() => setType('income')}>
                  Earning
                </SegmentButton>
              </SegmentGroup>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_EMOJI_CHOICES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setIcon(e)}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-lg border text-lg transition',
                    icon === e
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-secondary/40 hover:bg-accent',
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Colour</Label>
            <div className="flex flex-wrap gap-2">
              {COLOR_CHOICES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Pick ${c}`}
                  className={cn(
                    'h-8 w-8 rounded-full ring-2 transition',
                    color === c ? 'ring-foreground' : 'ring-transparent hover:ring-border',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                name: trimmed,
                icon,
                color,
                type,
              })
            }
            disabled={!canSubmit || submitting}
          >
            {submitting ? 'Saving…' : editing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReassignDialog({ open, onOpenChange, target, candidates, onConfirm, submitting }) {
  const [reassignTo, setReassignTo] = useState('');

  useEffect(() => {
    if (!open) return;
    setReassignTo(candidates[0]?.id ?? '');
  }, [open, candidates]);

  if (!target) return null;
  const txCount = target.transactionCount ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign before deleting</DialogTitle>
          <DialogDescription>
            “{target.name}” has {txCount} {txCount === 1 ? 'transaction' : 'transactions'}. Pick a
            category to move them to first.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You have no other {target.type === 'expense' ? 'spending' : 'earning'} categories to
            reassign to. Create one first.
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label>Move transactions to</Label>
            <Select value={reassignTo} onValueChange={setReassignTo}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="mr-2">{c.icon}</span>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(reassignTo)}
            disabled={!reassignTo || submitting || candidates.length === 0}
          >
            {submitting ? 'Working…' : 'Reassign & delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoryRow({ cat, onEdit, onDelete }) {
  const protectedRow = isProtected(cat);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/30 p-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
        style={{ backgroundColor: `${cat.color}22` }}
      >
        {cat.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{cat.name}</p>
        {cat.is_default ? (
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Default</p>
        ) : (
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Custom</p>
        )}
      </div>
      <div className="flex gap-0.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(cat)} aria-label={`Edit ${cat.name}`}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        {protectedRow ? (
          <span
            className="flex h-8 w-8 items-center justify-center text-muted-foreground/40"
            title="Protected — used as the reassign safety net"
            aria-label="Protected category"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </span>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(cat)}
            aria-label={`Delete ${cat.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function CategoryManager() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [reassignFor, setReassignFor] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories'),
  });
  const categories = data?.categories ?? [];
  const expense = categories.filter((c) => c.type === 'expense');
  const income = categories.filter((c) => c.type === 'income');

  function invalidateAffected() {
    queryClient.invalidateQueries({ queryKey: ['categories'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    queryClient.invalidateQueries({ queryKey: ['budgets'] });
    queryClient.invalidateQueries({ queryKey: ['analytics', 6] });
  }

  const createMutation = useMutation({
    mutationFn: (payload) => api.post('/api/categories', payload),
    onSuccess: () => {
      invalidateAffected();
      toast.success('Category added');
      setDialogOpen(false);
    },
    onError: (err) => toast.error(err?.message || 'Could not create category'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => api.patch(`/api/categories/${id}`, payload),
    onSuccess: () => {
      invalidateAffected();
      toast.success('Category updated');
      setDialogOpen(false);
      setEditing(null);
    },
    onError: (err) => toast.error(err?.message || 'Could not update'),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, reassignTo }) => {
      const path = reassignTo
        ? `/api/categories/${id}?reassign_to=${reassignTo}`
        : `/api/categories/${id}`;
      return api.del(path);
    },
    onSuccess: () => {
      invalidateAffected();
      toast.success('Category removed');
      setReassignFor(null);
    },
    onError: (err, vars) => {
      if (err?.status === 409 && err?.body?.transactionCount && !vars.reassignTo) {
        // Re-prompt with reassign dialog using the count from the server.
        const target = categories.find((c) => c.id === vars.id);
        if (target) {
          setReassignFor({ ...target, transactionCount: err.body.transactionCount });
          return;
        }
      }
      toast.error(err?.message || 'Could not delete');
    },
  });

  function handleSubmit(payload) {
    if (editing) {
      const patch = { name: payload.name, icon: payload.icon, color: payload.color };
      updateMutation.mutate({ id: editing.id, payload: patch });
    } else {
      createMutation.mutate(payload);
    }
  }

  function handleDelete(cat) {
    if (!confirm(`Delete “${cat.name}”? Any budget on this category will be removed too.`)) return;
    deleteMutation.mutate({ id: cat.id, reassignTo: null });
  }

  function handleReassignConfirm(reassignTo) {
    if (!reassignFor || !reassignTo) return;
    deleteMutation.mutate({ id: reassignFor.id, reassignTo });
  }

  return (
    <Card className="lift border-border/60 bg-card/70 backdrop-blur">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Manage categories</h2>
            <p className="text-sm text-muted-foreground">
              Rename, recolour, or add your own. Default categories carry a label so you know
              what's seeded.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Spending
              </h3>
              <div className="space-y-2">
                {expense.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No spending categories yet.</p>
                ) : (
                  expense.map((c) => (
                    <CategoryRow
                      key={c.id}
                      cat={c}
                      onEdit={(x) => {
                        setEditing(x);
                        setDialogOpen(true);
                      }}
                      onDelete={handleDelete}
                    />
                  ))
                )}
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Earning
              </h3>
              <div className="space-y-2">
                {income.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No earning categories yet.</p>
                ) : (
                  income.map((c) => (
                    <CategoryRow
                      key={c.id}
                      cat={c}
                      onEdit={(x) => {
                        setEditing(x);
                        setDialogOpen(true);
                      }}
                      onDelete={handleDelete}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>

      <CategoryDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) setEditing(null);
        }}
        editing={editing}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleSubmit}
      />

      <ReassignDialog
        open={!!reassignFor}
        onOpenChange={(v) => !v && setReassignFor(null)}
        target={reassignFor}
        candidates={
          reassignFor
            ? categories.filter((c) => c.type === reassignFor.type && c.id !== reassignFor.id)
            : []
        }
        submitting={deleteMutation.isPending}
        onConfirm={handleReassignConfirm}
      />
    </Card>
  );
}
