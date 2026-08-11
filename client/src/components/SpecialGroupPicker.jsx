import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/useApi';
import { cn } from '@/lib/utils';
import { invalidateMoney } from '@/lib/invalidate';

/**
 * Phase 10 (B1) — pick or create a group for a special expense.
 *
 * Grouping is OPTIONAL: "No group" is a first-class choice and the default, so
 * a special expense behaves exactly as it did before this feature existed.
 * Only rendered once the Special checkbox is ticked — a group means nothing on
 * a normal expense, and the server rejects that combination anyway.
 */
export function SpecialGroupPicker({ value, onChange, className }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');

  const { data } = useQuery({
    queryKey: ['special-groups'],
    queryFn: () => api.get('/api/special-groups'),
  });
  const groups = (data?.groups ?? []).filter((g) => !g.archivedAt);

  const createMutation = useMutation({
    mutationFn: (name) => api.post('/api/special-groups', { name }),
    onSuccess: (res) => {
      invalidateMoney(queryClient);
      onChange(res?.group?.id ?? null);
      setCreating(false);
      setDraft('');
    },
  });

  function submitNew(e) {
    e.preventDefault();
    e.stopPropagation();
    const name = draft.trim();
    if (!name || createMutation.isPending) return;
    createMutation.mutate(name);
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <p className="text-xs text-muted-foreground">Group it with (optional)</p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={value === null}
          className={cn(
            'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
            value === null
              ? 'border-primary/60 bg-primary/15 text-primary'
              : 'border-border/70 bg-secondary/40 text-muted-foreground hover:text-foreground',
          )}
        >
          No group
        </button>
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onChange(g.id)}
            aria-pressed={value === g.id}
            className={cn(
              'max-w-[14rem] truncate rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              value === g.id
                ? 'border-amber-400/60 bg-amber-400/15 text-amber-400'
                : 'border-border/70 bg-secondary/40 text-muted-foreground hover:text-foreground',
            )}
          >
            {g.name}
          </button>
        ))}
        {!creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border/70 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-3 w-3" aria-hidden />
            New group
          </button>
        ) : null}
      </div>

      {creating ? (
        <div className="flex items-center gap-1.5 pt-1">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // The dialog around this listens for Enter — don't let a group
              // name submit the whole transaction.
              if (e.key === 'Enter') submitNew(e);
            }}
            placeholder="e.g. September 2026 Paris holiday"
            maxLength={60}
            className="h-8 text-sm"
            autoFocus
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-8"
            onClick={submitNew}
            disabled={!draft.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? 'Adding…' : 'Add'}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label="Cancel new group"
            onClick={() => {
              setCreating(false);
              setDraft('');
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
