import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LogOut, Moon, Sun, Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AskChatbot } from '@/components/AskChatbot';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

const links = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/budgets', label: 'Budgets' },
  { to: '/savings', label: 'Savings' },
  { to: '/subscriptions', label: 'Subscriptions' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/settings', label: 'Settings' },
];

function useTheme() {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : true,
  );

  useEffect(() => {
    const el = document.documentElement;
    if (isDark) el.classList.add('dark');
    else el.classList.remove('dark');
    try {
      localStorage.setItem('trim-theme', isDark ? 'dark' : 'light');
    } catch {}
  }, [isDark]);

  return { isDark, toggle: () => setIsDark((v) => !v) };
}

/**
 * Phase 14 — report this device's IANA timezone so the server can bucket months
 * by the USER's calendar, not its own UTC clock. Silent and automatic: a setting
 * Alex has to find and keep correct while travelling is a setting that will be
 * wrong. Fires only when it actually differs from what is stored, so it costs
 * one PATCH after a flight and nothing at all otherwise.
 */
function useReportTimezone() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get('/api/me'),
  });
  const stored = me?.preferences?.timezone;

  useEffect(() => {
    if (!me) return;
    let local;
    try {
      local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return; // no Intl zone available — the server's UTC fallback is fine
    }
    if (!local || local === stored) return;
    api
      .patch('/api/me', { timezone: local })
      .then(() => queryClient.invalidateQueries({ queryKey: ['me'] }))
      .catch(() => {
        // Never surface this. A failed timezone report degrades to the previous
        // stored zone, which is what the user had a moment ago anyway.
      });
  }, [me, stored, api, queryClient]);
}

export default function App() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const { isDark, toggle } = useTheme();
  useReportTimezone();

  async function handleLogout() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      {/*
       * Ambient mesh — three drifting blobs sit behind the entire app.
       * Pointer-events off so they never trap clicks; fixed so scrolling
       * keeps the background calm rather than shoving the gradient around.
       */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="mesh-bg absolute inset-0" />
        <div className="absolute -top-32 -left-24 h-[28rem] w-[28rem] rounded-full bg-primary/10 blur-3xl animate-blob" />
        <div
          className="absolute -bottom-40 -right-24 h-[32rem] w-[32rem] rounded-full bg-primary/[0.08] blur-3xl animate-blob"
          style={{ animationDelay: '-5s' }}
        />
      </div>

      <header className="sticky top-0 z-30 border-b border-border/60 glass">
        <div className="container flex items-center justify-between gap-3 px-4 py-3 sm:py-4">
          <Link to="/dashboard" className="group flex items-center gap-2.5">
            <span className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-emerald-700 text-primary-foreground shadow-lg shadow-primary/30 transition-transform group-hover:scale-105">
              <Scissors className="h-4 w-4" strokeWidth={2.5} />
              <span className="absolute inset-0 rounded-xl ring-1 ring-white/15" />
            </span>
            <span className="hidden text-base font-bold tracking-tight sm:inline">
              <span className="text-gradient">Trim</span>
            </span>
          </Link>

          <nav className="hidden flex-1 justify-center gap-0.5 md:flex">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  cn(
                    'relative rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <span className="absolute inset-0 -z-10 rounded-lg bg-accent/80" />
                    ) : null}
                    {l.label}
                    {isActive ? (
                      <span className="absolute inset-x-3 -bottom-[5px] h-[2px] rounded-full bg-primary" />
                    ) : null}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label="Toggle theme"
              className="rounded-lg"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              aria-label="Log out"
              className="rounded-lg"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Mobile nav — horizontally scrollable */}
        <nav className="container flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                cn(
                  'whitespace-nowrap rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/30'
                    : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="container px-4 py-6 sm:py-8">
        <Outlet />
      </main>

      <AskChatbot />
    </div>
  );
}
