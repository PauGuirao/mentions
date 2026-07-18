import { Link } from '@tanstack/react-router';
import { AlertCircle, KeyRound } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, hasCredentials } from '@/lib/api';

/** 401s and missing credentials render a connect prompt; anything else an alert. */
export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!hasCredentials() || (error instanceof ApiError && error.status === 401)) {
    return <ConnectPrompt />;
  }
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>Request failed</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function ConnectPrompt() {
  return (
    <Card className="items-center gap-3 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <KeyRound className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">Connect to your Mentions API</p>
        <p className="text-sm text-muted-foreground">
          Sign in with your account, or add an API key in settings.
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" render={<Link to="/login" />}>
          Sign in
        </Button>
        <Button size="sm" variant="outline" render={<Link to="/settings" />}>
          Open settings
        </Button>
      </div>
    </Card>
  );
}
