import type { UsageSummary } from '@mentions/core/schemas';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';

type Trial = NonNullable<UsageSummary['trial']>;

/** Thin reminder above the app while the trial is running. */
export function TrialBanner({ trial }: { trial: Trial }) {
  const msLeft = Math.max(0, trial.endsAt - Date.now());
  const hours = Math.ceil(msLeft / 3_600_000);
  const timeLabel = hours >= 48 ? `${Math.ceil(hours / 24)} days` : `${hours} hour${hours === 1 ? '' : 's'}`;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-muted px-6 py-2 text-xs text-muted-foreground">
      <span>
        Free trial: {timeLabel} left, {trial.mentionsUsed} of {trial.mentionsLimit}
        mentions used.
      </span>
      <Link
        to="/settings"
        className="shrink-0 font-medium text-foreground underline-offset-4 hover:underline"
      >
        Add a card
      </Link>
    </div>
  );
}

/** Full stop: replaces the app when the trial ran out without a card. */
export function TrialWall() {
  const checkoutMutation = useMutation({
    mutationFn: () =>
      api.createBillingCheckout(`${window.location.origin}/settings?billing=success`),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.status === 503
          ? 'Billing is not configured on this deployment.'
          : 'Could not start the checkout.',
      ),
  });

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-md gap-4 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Your free trial has ended</h1>
        <p className="text-sm text-muted-foreground">
          Tracking is paused: your keywords are no longer being watched and new mentions are not
          collected. Add a card to pick up right where you left off.
        </p>
        <div className="grid gap-1.5 border border-border bg-muted/40 p-4 text-sm">
          <p className="font-medium">Pay per use, self serve</p>
          <p className="text-muted-foreground">EUR 5 per keyword per month, prorated daily.</p>
          <p className="text-muted-foreground">
            First 100 mentions each month free, then EUR 8 per 1,000.
          </p>
          <p className="text-muted-foreground">No seats, no tiers, no caps.</p>
        </div>
        <Button
          className="w-full"
          onClick={() => checkoutMutation.mutate()}
          disabled={checkoutMutation.isPending}
        >
          {checkoutMutation.isPending ? 'Starting checkout...' : 'Add a card and continue'}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Cancel anytime from the billing portal. Your keywords and history stay saved.
        </p>
      </Card>
    </div>
  );
}
