import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LogOut, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

const links = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/budgets', label: 'Budgets' },
  { to: '/savings', label: 'Savings' },
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

export default function App() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const { isDark, toggle } = useTheme();

  async function handleLogout() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="container flex items-center justify-between gap-3 px-4 py-3 sm:py-4">
          <Link to="/dashboard" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-bold">
              T
            </span>
            <span className="hidden text-base font-semibold tracking-tight sm:inline">Trim</span>
          </Link>

          <nav className="hidden flex-1 justify-center gap-1 md:flex">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Log out">
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
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
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
    </div>
  );
}
