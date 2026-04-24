import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
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
    // With email confirmation off, Supabase returns a session and onAuthStateChange
    // will trigger the redirect above.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5 text-center">
          <p className="text-2xl font-bold tracking-tight text-primary">Trim</p>
          <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
          <p className="text-sm text-muted-foreground">
            Trim your spending. Grow your savings.
          </p>
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
            <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
            {errors.password ? (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            ) : null}
          </div>

          {submitError ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{submitError}</p>
          ) : null}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create account
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
