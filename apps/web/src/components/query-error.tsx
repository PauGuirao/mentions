import { Link } from '@tanstack/react-router';
import { AlertCircle, KeyRound } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, hasApiKey } from '@/lib/api';

/** 401s and a missing key render a connect prompt; anything else an alert. */
export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!hasApiKey() || (error instanceof ApiError && error.status === 401)) {
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
          Add your API key in settings to load data from the API.
        </p>
      </div>
      <Button size="sm" render={<Link to="/settings" />}>
        Open settings
      </Button>
    </Card>
  );
}
