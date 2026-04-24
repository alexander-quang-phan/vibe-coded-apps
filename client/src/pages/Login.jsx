import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(6, 'At least 6 characters'),
});

export default function Login() {
  const { signIn, session, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitError, setSubmitError] = useState(null);

  const redirectTo = location.state?.from ?? '/dashboard';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  useEffect(() => {
    if (session) navigate(redirectTo, { replace: true });
  }, [session, navigate, redirectTo]);

  if (isLoading) return null;
  if (session) return <Navigate to={redirectTo} replace />;

  async function onSubmit(values) {
    setSubmitError(null);
    const { error } = await signIn(values.email, values.password);
    // Generic message on any failure so we don't reveal whether the email exists.
    if (error) setSubmitError('Email or password is incorrect');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5 text-center">
          <p className="text-2xl font-bold tracking-tight text-primary">Trim</p>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">Log in to keep your streak alive.</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
            <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
            {errors.password ? (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            ) : null}
          </div>

          {submitError ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{submitError}</p>
          ) : null}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Log in
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          No account?{' '}
          <Link to="/signup" className="font-medium text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
