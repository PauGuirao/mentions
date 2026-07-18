import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api, hasCredentials, setSession } from '@/lib/api';

export const Route = createFileRoute('/login')({
  beforeLoad: () => {
    if (hasCredentials()) throw redirect({ to: '/mentions' });
  },
  component: LoginPage,
});

type Mode = 'login' | 'signup';

function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!email || !password) {
      toast.error('Email and password are required');
      return;
    }
    setPending(true);
    try {
      const result =
        mode === 'login'
          ? await api.login({ email, password })
          : await api.signup({
              email,
              password,
              ...(name ? { name } : {}),
              ...(orgName ? { orgName } : {}),
            });
      setSession(result.token, result.user.email);
      await navigate({ to: '/mentions' });
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error('Could not reach the API');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
              @
            </span>
            <span className="font-semibold tracking-tight">Mentions</span>
          </div>
          <CardTitle>{mode === 'login' ? 'Sign in' : 'Create your account'}</CardTitle>
          <CardDescription>
            {mode === 'login'
              ? 'Track keyword and brand mentions across dev platforms.'
              : 'A workspace is created with your account.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder={mode === 'login' ? '' : 'At least 8 characters'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          </div>
          {mode === 'signup' ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="name">Your name (optional)</Label>
                <Input
                  id="name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="org-name">Workspace name (optional)</Label>
                <Input
                  id="org-name"
                  placeholder="Acme Inc"
                  value={orgName}
                  onChange={(event) => setOrgName(event.target.value)}
                />
              </div>
            </>
          ) : null}
        </CardContent>
        <CardFooter className="grid gap-3">
          <Button className="w-full" onClick={() => void submit()} disabled={pending}>
            {pending
              ? mode === 'login'
                ? 'Signing in...'
                : 'Creating account...'
              : mode === 'login'
                ? 'Sign in'
                : 'Create account'}
          </Button>
          <button
            type="button"
            className="text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
          >
            {mode === 'login' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
          </button>
        </CardFooter>
      </Card>
    </div>
  );
}
