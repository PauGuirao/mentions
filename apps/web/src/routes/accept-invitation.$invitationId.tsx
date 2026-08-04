import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { authClient } from '@/lib/auth-client';

export const Route = createFileRoute('/accept-invitation/$invitationId')({
  component: AcceptInvitationPage,
});

type AcceptState = { phase: 'accepting' } | { phase: 'done' } | { phase: 'error'; message: string };

function AcceptInvitationPage() {
  const { invitationId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AcceptState>({ phase: 'accepting' });
  // React 18 StrictMode double-mounts effects; accepting twice would turn a
  // success into an "already accepted" error screen.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      const { data, error } = await authClient.organization.acceptInvitation({ invitationId });
      if (error || !data) {
        setState({
          phase: 'error',
          message: error?.message ?? 'This invitation is invalid or has expired.',
        });
        return;
      }
      const orgId = data.invitation.organizationId;
      await authClient.organization.setActive({ organizationId: orgId });
      // Every query is org-scoped; the new workspace must load fresh.
      queryClient.clear();
      setState({ phase: 'done' });
      await navigate({ to: '/' });
    })();
  }, [invitationId, navigate, queryClient]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
              @
            </span>
            <span className="font-semibold tracking-tight">Mentio</span>
          </div>
          <CardTitle>Workspace invitation</CardTitle>
          <CardDescription>
            {state.phase === 'accepting'
              ? 'Joining the workspace...'
              : state.phase === 'done'
                ? 'You are in. Redirecting...'
                : 'The invitation could not be accepted.'}
          </CardDescription>
        </CardHeader>
        {state.phase === 'error' ? (
          <>
            <CardContent>
              <p className="text-sm text-muted-foreground">{state.message}</p>
            </CardContent>
            <CardFooter>
              <Button className="w-full" onClick={() => void navigate({ to: '/' })}>
                Go to my workspace
              </Button>
            </CardFooter>
          </>
        ) : null}
      </Card>
    </div>
  );
}
