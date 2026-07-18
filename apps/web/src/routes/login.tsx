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
import { hasCredentials } from '@/lib/api';
import { authClient, markLoggedIn } from '@/lib/auth-client';

export const Route = createFileRoute('/login')({
  beforeLoad: () => {
    if (hasCredentials()) throw redirect({ to: '/mentions' });
  },
  component: LoginPage,
});

type Mode = 'login' | 'signup';

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.8c2.2-2 3.7-5 3.7-8.5z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1 7.9-2.9l-3.7-2.8c-1 .7-2.4 1.2-4.2 1.2-3.1 0-5.8-2-6.7-4.9l-3.9 3C3.4 21.3 7.4 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.3 14.6c-.2-.7-.4-1.4-.4-2.2s.1-1.5.4-2.2l-3.9-3C.5 8.8 0 10.3 0 12s.5 3.2 1.4 4.8l3.9-3.2z"
      />
      <path
        fill="#EA4335"
        d="M12 4.6c2.2 0 3.7 1 4.6 1.8L20 3.1C17.9 1.2 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.6l3.9 3c.9-2.9 3.6-5 6.7-5z"
      />
    </svg>
  );
}

function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  const submitEmail = async () => {
    if (!email || !password) {
      toast.error('Email and password are required');
      return;
    }
    setPending(true);
    try {
      const result =
        mode === 'login'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({
              email,
              password,
              name: name || (email.split('@')[0] ?? email),
            });
      if (result.error) {
        toast.error(result.error.message ?? 'Authentication failed');
        return;
      }
      markLoggedIn();
      await navigate({ to: '/mentions' });
    } finally {
      setPending(false);
    }
  };

  const signInWithGoogle = async () => {
    // Full-page redirect to Google; on success Better Auth lands the browser
    // back on /mentions with the session cookie set. The marker is set now
    // because this tab navigates away and never sees the callback.
    markLoggedIn();
    const { error } = await authClient.signIn.social({
      provider: 'google',
      callbackURL: '/mentions',
    });
    if (error) {
      toast.error(error.message ?? 'Google sign-in failed');
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
          <Button variant="outline" className="w-full" onClick={() => void signInWithGoogle()}>
            <GoogleIcon />
            Continue with Google
          </Button>
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>
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
                if (event.key === 'Enter') void submitEmail();
              }}
            />
          </div>
          {mode === 'signup' ? (
            <div className="grid gap-2">
              <Label htmlFor="name">Your name (optional)</Label>
              <Input
                id="name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="grid gap-3">
          <Button className="w-full" onClick={() => void submitEmail()} disabled={pending}>
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
