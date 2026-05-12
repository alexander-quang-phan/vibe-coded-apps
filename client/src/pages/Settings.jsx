import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
import { CategoryManager } from '@/components/CategoryManager';

const CURRENCIES = [
  { code: 'GBP', label: 'GBP · British Pound' },
  { code: 'USD', label: 'USD · US Dollar' },
  { code: 'AUD', label: 'AUD · Australian Dollar' },
  { code: 'VND', label: 'VND · Vietnamese Dong' },
];

function SettingsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24" />
      <Skeleton className="h-40" />
      <Skeleton className="h-32" />
    </div>
  );
}

export default function Settings() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { user, signOut } = useAuth();

  const { data, isLoading } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/api/me') });

  const [currency, setCurrency] = useState('GBP');
  const [simpleMode, setSimpleMode] = useState(false);
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    if (!data) return;
    setCurrency(data.preferences.currency ?? 'GBP');
    setSimpleMode(!!data.preferences.simpleMode);
    setDisplayName(data.preferences.displayName ?? '');
  }, [data]);

  const updateMutation = useMutation({
    mutationFn: (payload) => api.patch('/api/me', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Preferences saved');
    },
    onError: (err) => toast.error(err?.message || 'Could not save'),
  });

  function saveCurrency(next) {
    setCurrency(next);
    updateMutation.mutate({ currency: next });
  }

  function saveSimpleMode(next) {
    setSimpleMode(next);
    updateMutation.mutate({ simpleMode: next });
  }

  function saveDisplayName() {
    const trimmed = displayName.trim();
    if (trimmed === (data?.preferences?.displayName ?? '')) return;
    updateMutation.mutate({ displayName: trimmed || null });
  }

  return (
    <div className="space-y-5 pb-12 animate-fade-up">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">Make Trim feel like yours.</p>
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Settings</h1>
      </header>

      {isLoading ? (
        <SettingsSkeleton />
      ) : (
        <>
          <Card className="lift border-border/60 bg-card/70 backdrop-blur">
            <CardContent className="space-y-4 p-5">
              <div>
                <h2 className="font-semibold">Account</h2>
                <p className="text-sm text-muted-foreground">Signed in as {user?.email}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="display-name">Display name</Label>
                <div className="flex gap-2">
                  <Input
                    id="display-name"
                    value={displayName}
                    maxLength={50}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="How should we greet you?"
                  />
                  <Button
                    variant="outline"
                    onClick={saveDisplayName}
                    disabled={
                      updateMutation.isPending ||
                      displayName.trim() === (data?.preferences?.displayName ?? '')
                    }
                  >
                    <Check className="h-4 w-4" /> Save
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="lift border-border/60 bg-card/70 backdrop-blur">
            <CardContent className="space-y-4 p-5">
              <div>
                <h2 className="font-semibold">Preferences</h2>
                <p className="text-sm text-muted-foreground">
                  These tweak how numbers and categories show up.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select value={currency} onValueChange={saveCurrency}>
                  <SelectTrigger className="max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Display only — Trim doesn't convert between currencies.
                </p>
              </div>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-secondary/40 p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="simple-mode" className="cursor-pointer">
                    Simple mode
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    One monthly total, no categories. Great if you're just starting out.
                  </p>
                </div>
                <button
                  id="simple-mode"
                  type="button"
                  role="switch"
                  aria-checked={simpleMode}
                  onClick={() => saveSimpleMode(!simpleMode)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                    simpleMode ? 'bg-primary' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform ${
                      simpleMode ? 'translate-x-[22px]' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </CardContent>
          </Card>

          <CategoryManager />

          <Card className="lift border-border/60 bg-card/70 backdrop-blur">
            <CardContent className="space-y-3 p-5">
              <div>
                <h2 className="font-semibold">Session</h2>
                <p className="text-sm text-muted-foreground">
                  Sign out on this device. Your data stays put.
                </p>
              </div>
              <Button variant="outline" onClick={() => signOut()}>
                Sign out
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
