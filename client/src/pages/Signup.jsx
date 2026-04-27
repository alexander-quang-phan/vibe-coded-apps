import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
});

export default function Signup() {
  const { signUp, session, isLoading } = useAuth();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  useEffect(() => {
    if (session) navigate('/dashboard', { replace: true });
  }, [session, navigate]);

  if (isLoading) return null;
  if (session) return <Navigate to="/dashboard" replace />;

  async function onSubmit(values) {
    setSubmitError(null);
    const { error } = await signUp(values.email, values.password);
    if (error) setSubmitError(error.message || 'Unable to sign up');
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="mesh-bg absolute inset-0" />
        <div className="absolute -top-32 right-1/4 h-96 w-96 rounded-full bg-primary/15 blur-3xl animate-blob" />
        <div
          className="absolute bottom-0 left-1/4 h-96 w-96 rounded-full bg-emerald-300/10 blur-3xl animate-blob"
          style={{ animationDelay: '-7s' }}
        />
      </div>

      <div className="w-full max-w-sm space-y-7 animate-fade-up">
        <div className="space-y-3 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-emerald-700 text-primary-foreground shadow-xl shadow-primary/30 ring-1 ring-white/20 animate-pop-in">
            <Scissors className="h-6 w-6" strokeWidth={2.5} />
          </div>
          <div className="space-y-1">
            <h1 className="text-3xl font-extrabold tracking-tight">
              Start your <span className="text-gradient">Trim</span>
            </h1>
            <p className="text-sm text-muted-foreground">
              Trim your spending. Grow your savings.
            </p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4 rounded-2xl border border-border/60 bg-card/70 p-6 shadow-xl shadow-primary/[0.06] backdrop-blur-md"
        >
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              {...register('email')}
            />
            {errors.email ? <p className="text-xs text-destructive">{errors.email.message}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
            {errors.password ? (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            ) : null}
          </div>

          {submitError ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{submitError}</p>
          ) : null}

          <Button
            type="submit"
            className="w-full bg-gradient-to-br from-primary to-emerald-700 shadow-lg shadow-primary/30 transition-all hover:scale-[1.01] hover:shadow-primary/50"
            disabled={isSubmitting}
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create account
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-primary hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
