import type { CompanyProfile, Source, UsageSummary } from '@mentions/core/schemas';
import { SOURCES } from '@mentions/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { SourceIcon } from '@/components/source-icon';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api, getApiKey, getApiUrl, hasApiKey, hasCredentials, setApiKey, setApiUrl } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { SOURCE_LABELS } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/settings')({ component: SettingsPage });

const DESCRIPTION_MAX = 2000;
const MAX_USE_CASES = 10;

function SettingsPage() {
  const queryClient = useQueryClient();
  const [apiUrl, setApiUrlState] = useState(getApiUrl);
  const [apiKey, setApiKeyState] = useState(getApiKey);
  const [testing, setTesting] = useState(false);

  const saveAndTest = async () => {
    setApiUrl(apiUrl);
    setApiKey(apiKey);
    queryClient.clear();
    if (!hasApiKey()) {
      toast.success('Settings saved. Add an API key to load data.');
      return;
    }
    setTesting(true);
    try {
      const { keywords } = await api.listKeywords();
      toast.success(`Connected. ${keywords.length} keyword${keywords.length === 1 ? '' : 's'} found.`);
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(`API responded ${err.status}: ${err.message}`);
      } else {
        toast.error('Could not reach the API. Check the URL and that the API worker is running.');
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="px-6 py-6">
      <PageHeader title="Settings" description="Connection and classifier context." />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>API connection</CardTitle>
            <CardDescription>
              The key is stored only in this browser and sent as a Bearer token.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="api-url">API base URL</Label>
              <Input
                id="api-url"
                autoComplete="off"
                placeholder="Same origin (recommended)"
                value={apiUrl}
                onChange={(event) => setApiUrlState(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to use this app's origin: the dev server proxies /v1 to
                localhost:8787, and the deployed worker forwards to the API. Only set a URL to
                hit a different API directly.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="api-key">API key</Label>
              <Input
                id="api-key"
                type="password"
                autoComplete="new-password"
                placeholder="mk_live_..."
                value={apiKey}
                onChange={(event) => setApiKeyState(event.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={() => void saveAndTest()} disabled={testing}>
              {testing ? 'Testing...' : 'Save and test connection'}
            </Button>
          </CardFooter>
        </Card>

        <BillingCard />

        <MembersCard />

        <SlackCard />

        <XSourceCard />

        <CompanyProfileCard />
      </div>
    </div>
  );
}

const ROLE_ITEMS: Record<string, string> = {
  member: 'Member',
  admin: 'Admin',
};

function MembersCard() {
  const meQuery = useMe();
  const me = meQuery.data;
  const activeOrgId = me?.activeOrgId ?? null;
  const myRole = me?.orgs.find((o) => o.id === activeOrgId)?.role ?? 'member';
  const canManage = myRole === 'owner' || myRole === 'admin';

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');

  const membersQuery = useQuery({
    queryKey: ['orgMembers', activeOrgId],
    queryFn: async () => {
      const { data, error } = await authClient.organization.listMembers({
        query: { organizationId: activeOrgId ?? '' },
      });
      if (error) throw new Error(error.message ?? 'Failed to load members');
      return data;
    },
    enabled: activeOrgId !== null,
  });

  const invitationsQuery = useQuery({
    queryKey: ['orgInvitations', activeOrgId],
    queryFn: async () => {
      const { data, error } = await authClient.organization.listInvitations({
        query: { organizationId: activeOrgId ?? '' },
      });
      if (error) throw new Error(error.message ?? 'Failed to load invitations');
      return data;
    },
    enabled: activeOrgId !== null && canManage,
  });
  const pendingInvitations = (invitationsQuery.data ?? []).filter((i) => i.status === 'pending');

  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['orgMembers', activeOrgId] });
    void queryClient.invalidateQueries({ queryKey: ['orgInvitations', activeOrgId] });
  };

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole as 'member' | 'admin',
        organizationId: activeOrgId ?? undefined,
      });
      if (error) throw new Error(error.message ?? 'Failed to send the invitation');
    },
    onSuccess: () => {
      toast.success(`Invitation sent to ${inviteEmail.trim()}`);
      setInviteEmail('');
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Invitation failed'),
  });

  const cancelMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      const { error } = await authClient.organization.cancelInvitation({ invitationId });
      if (error) throw new Error(error.message ?? 'Failed to cancel');
    },
    onSuccess: () => {
      toast.success('Invitation canceled');
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Cancel failed'),
  });

  const removeMutation = useMutation({
    mutationFn: async (memberId: string) => {
      const { error } = await authClient.organization.removeMember({
        memberIdOrEmail: memberId,
        organizationId: activeOrgId ?? undefined,
      });
      if (error) throw new Error(error.message ?? 'Failed to remove the member');
    },
    onSuccess: () => {
      toast.success('Member removed');
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Removal failed'),
  });

  // API-key-only sessions have no user identity, so there is nothing to show.
  if (!me) return null;

  const members = membersQuery.data?.members ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team members</CardTitle>
        <CardDescription>
          People in this workspace. Invitations arrive by email and expire after 48 hours.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          {members.map((member) => (
            <div key={member.id} className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {member.user.name || member.user.email}
                <span className="ml-2 text-xs text-muted-foreground">{member.user.email}</span>
              </span>
              <Badge variant={member.role === 'owner' ? 'default' : 'secondary'}>
                {member.role}
              </Badge>
              {canManage && member.role !== 'owner' && member.user.email !== me.user.email ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${member.user.email}`}
                  onClick={() => removeMutation.mutate(member.id)}
                  disabled={removeMutation.isPending}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ))}
          {membersQuery.isPending && activeOrgId ? (
            <p className="text-sm text-muted-foreground">Loading members...</p>
          ) : null}
        </div>

        {pendingInvitations.length > 0 ? (
          <div className="grid gap-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">Pending invitations</p>
            {pendingInvitations.map((invitation) => (
              <div key={invitation.id} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{invitation.email}</span>
                <Badge variant="outline">{invitation.role ?? 'member'}</Badge>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Cancel invitation for ${invitation.email}`}
                  onClick={() => cancelMutation.mutate(invitation.id)}
                  disabled={cancelMutation.isPending}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {canManage ? (
          <div className="grid gap-2 border-t pt-3 sm:grid-cols-[1fr_auto_auto]">
            <Input
              type="email"
              placeholder="teammate@company.com"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
            />
            <Select
              items={ROLE_ITEMS}
              value={inviteRole}
              onValueChange={(value) => setInviteRole(value ?? 'member')}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ROLE_ITEMS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => inviteMutation.mutate()}
              disabled={inviteEmail.trim() === '' || inviteMutation.isPending}
            >
              {inviteMutation.isPending ? 'Sending...' : 'Invite'}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const RELEVANCE_ITEMS: Record<string, string> = {
  '0': 'All relevant mentions',
  '50': 'Relevance 50 and up',
  '70': 'Relevance 70 and up',
  '85': 'Relevance 85 and up',
};

function SlackCard() {
  const queryClient = useQueryClient();
  const [channelId, setChannelId] = useState('');
  const [minRelevance, setMinRelevance] = useState('50');

  const statusQuery = useQuery({
    queryKey: ['slackStatus'],
    queryFn: api.getSlackStatus,
    enabled: hasCredentials(),
  });
  const status = statusQuery.data;
  const connected = status?.connected ?? false;

  const channelsQuery = useQuery({
    queryKey: ['slackChannels'],
    queryFn: api.listSlackChannels,
    enabled: hasCredentials() && connected,
  });
  const channels = channelsQuery.data?.channels ?? [];

  // All selected = no source filter saved (notifications for every platform).
  const [sources, setSources] = useState<Source[]>(() => [...SOURCES]);
  const toggleSource = (source: Source) =>
    setSources((prev) =>
      prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source],
    );

  // Seed the form from the saved config once status arrives.
  useEffect(() => {
    const saved = statusQuery.data?.notifications;
    if (!saved) return;
    setChannelId(saved.channelId);
    setMinRelevance(saved.minRelevance === null ? '0' : String(saved.minRelevance));
    setSources(saved.sources ?? [...SOURCES]);
  }, [statusQuery.data]);

  // The OAuth callback lands back here with ?slack=connected|error|cancelled.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('slack');
    if (!result) return;
    if (result === 'connected') toast.success('Slack workspace connected');
    else if (result === 'cancelled') toast('Slack connection cancelled');
    else toast.error('Slack connection failed. Try again.');
    params.delete('slack');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    void queryClient.invalidateQueries({ queryKey: ['slackStatus'] });
  }, [queryClient]);

  const connectMutation = useMutation({
    mutationFn: api.startSlackInstall,
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.status === 503
          ? 'Slack is not configured on this deployment.'
          : 'Could not start the Slack install.',
      ),
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const channel =
        channels.find((c) => c.id === channelId) ??
        (status?.notifications?.channelId === channelId
          ? { id: channelId, name: status.notifications.channelName }
          : null);
      if (!channel) throw new Error('Pick a channel first');
      const min = Number(minRelevance);
      return api.setSlackNotifications({
        channelId: channel.id,
        channelName: channel.name,
        ...(min > 0 ? { minRelevance: min } : {}),
        ...(sources.length > 0 && sources.length < SOURCES.length ? { sources } : {}),
      });
    },
    onSuccess: (next) => {
      toast.success('Slack notifications are on');
      queryClient.setQueryData(['slackStatus'], next);
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to save notifications'),
  });

  const disableMutation = useMutation({
    mutationFn: api.disableSlackNotifications,
    onSuccess: (next) => {
      toast.success('Slack notifications turned off');
      queryClient.setQueryData(['slackStatus'], next);
      setChannelId('');
    },
    onError: () => toast.error('Failed to turn off notifications'),
  });

  const disconnectMutation = useMutation({
    mutationFn: api.disconnectSlack,
    onSuccess: () => {
      toast.success('Slack disconnected');
      setChannelId('');
      void queryClient.invalidateQueries({ queryKey: ['slackStatus'] });
      void queryClient.invalidateQueries({ queryKey: ['slackChannels'] });
    },
    onError: () => toast.error('Failed to disconnect Slack'),
  });

  const busy =
    saveMutation.isPending || disableMutation.isPending || disconnectMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack notifications</CardTitle>
        <CardDescription>
          Connect a workspace and the Mentions bot posts new relevant mentions to a channel you
          pick. Public channels work without inviting the bot.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!connected ? (
          <p className="text-sm text-muted-foreground">
            {status?.configured === false
              ? 'This deployment has no Slack app credentials configured.'
              : 'No workspace connected yet.'}
          </p>
        ) : (
          <>
            <p className="text-sm">
              Connected to <span className="font-medium">{status?.teamName}</span>
              {status?.notifications ? (
                <span className="text-muted-foreground">
                  {' '}
                  , posting to #{status.notifications.channelName}
                </span>
              ) : (
                <span className="text-muted-foreground"> , notifications off</span>
              )}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Channel</Label>
                <Select
                  items={Object.fromEntries(channels.map((c) => [c.id, `#${c.name}`]))}
                  value={channelId || null}
                  onValueChange={(value) => setChannelId(value ?? '')}
                >
                  <SelectTrigger disabled={channelsQuery.isPending}>
                    <SelectValue placeholder="Pick a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        #{channel.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Notify for</Label>
                <Select
                  items={RELEVANCE_ITEMS}
                  value={minRelevance}
                  onValueChange={(value) => setMinRelevance(value ?? '0')}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(RELEVANCE_ITEMS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Platforms</Label>
              <div className="flex flex-wrap gap-1.5">
                {SOURCES.map((source) => {
                  const active = sources.includes(source);
                  return (
                    <button
                      key={source}
                      type="button"
                      onClick={() => toggleSource(source)}
                      className={cn(
                        'flex items-center gap-1.5 border px-2 py-1 text-xs transition-colors',
                        active
                          ? 'border-border bg-card text-foreground'
                          : 'border-transparent bg-muted text-muted-foreground opacity-60',
                      )}
                    >
                      <SourceIcon source={source} />
                      {SOURCE_LABELS[source]}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {sources.length === 0 || sources.length === SOURCES.length
                  ? 'Notifying for every platform. Click a platform to exclude it.'
                  : `Notifying only for ${sources.length} platform${sources.length === 1 ? '' : 's'}.`}
              </p>
            </div>
          </>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        {!connected ? (
          <Button
            onClick={() => connectMutation.mutate()}
            disabled={
              !hasCredentials() ||
              statusQuery.isPending ||
              connectMutation.isPending ||
              status?.configured === false
            }
          >
            {connectMutation.isPending ? 'Redirecting...' : 'Connect Slack'}
          </Button>
        ) : (
          <>
            <Button onClick={() => saveMutation.mutate()} disabled={busy || channelId === ''}>
              {saveMutation.isPending
                ? 'Saving...'
                : status?.notifications
                  ? 'Update notifications'
                  : 'Turn on notifications'}
            </Button>
            {status?.notifications ? (
              <Button variant="outline" onClick={() => disableMutation.mutate()} disabled={busy}>
                Turn off
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => disconnectMutation.mutate()} disabled={busy}>
              Disconnect
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

function CompanyProfileCard() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [useCases, setUseCases] = useState<string[]>([]);
  const [xAccount, setXAccount] = useState('');
  const [linkedinAccount, setLinkedinAccount] = useState('');

  const profileQuery = useQuery({
    queryKey: ['companyProfile'],
    queryFn: api.getCompanyProfile,
    enabled: hasCredentials(),
  });

  useEffect(() => {
    const profile = profileQuery.data;
    if (!profile) return;
    setName(profile.name);
    setDescription(profile.description);
    setUseCases(profile.useCases);
    setXAccount(profile.xAccount ?? '');
    setLinkedinAccount(profile.linkedinAccount ?? '');
  }, [profileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const profile: CompanyProfile = {
        name: name.trim(),
        description: description.trim(),
        useCases: useCases.map((u) => u.trim()).filter((u) => u !== ''),
        xAccount: xAccount.trim().replace(/^@/, '') || null,
        linkedinAccount: linkedinAccount.trim() || null,
      };
      return api.setCompanyProfile(profile);
    },
    onSuccess: () => {
      toast.success('Company profile saved');
      void queryClient.invalidateQueries({ queryKey: ['companyProfile'] });
      void queryClient.invalidateQueries({ queryKey: ['company'] });
      // The profile name is the sidebar brand name.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save profile'),
  });

  const disabled = !hasCredentials() || profileQuery.isLoading;
  const setUseCase = (index: number, value: string) =>
    setUseCases(useCases.map((u, i) => (i === index ? value : u)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Company profile</CardTitle>
        <CardDescription>
          Used to personalize relevance scoring: the classifier context is built from this
          profile, so the more specific it is, the better your feed gets.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-2">
          <Label htmlFor="company-name">Company name</Label>
          <Input
            id="company-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={disabled}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="company-description">Company description</Label>
          <Textarea
            id="company-description"
            rows={5}
            maxLength={DESCRIPTION_MAX}
            placeholder="We build X for Y. Our product does..."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={disabled}
          />
          <p className="text-right text-xs text-muted-foreground">
            {description.length}/{DESCRIPTION_MAX}
          </p>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Label>Product use cases</Label>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add use case"
              onClick={() => setUseCases([...useCases, ''])}
              disabled={disabled || useCases.length >= MAX_USE_CASES}
            >
              <Plus />
            </Button>
          </div>
          {useCases.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Concrete jobs your product is hired for. One per line, added with the plus button.
            </p>
          ) : null}
          {useCases.map((useCase, index) => (
            // Index keys are fine: rows are only appended/removed by position.
            // eslint-disable-next-line react/no-array-index-key
            <div key={index} className="flex items-center gap-2">
              <Input
                value={useCase}
                placeholder="Add cross-platform publishing to a SaaS product"
                onChange={(event) => setUseCase(index, event.target.value)}
                disabled={disabled}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove use case"
                onClick={() => setUseCases(useCases.filter((_, i) => i !== index))}
                disabled={disabled}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="x-account">X/Twitter account</Label>
          <Input
            id="x-account"
            placeholder="Company username without the @"
            value={xAccount}
            onChange={(event) => setXAccount(event.target.value)}
            disabled={disabled}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="linkedin-account">LinkedIn account</Label>
          <Input
            id="linkedin-account"
            placeholder="Company LinkedIn name as shown in your profile"
            value={linkedinAccount}
            onChange={(event) => setLinkedinAccount(event.target.value)}
            disabled={disabled}
          />
        </div>
      </CardContent>
      <CardFooter>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={disabled || saveMutation.isPending || name.trim() === ''}
        >
          {saveMutation.isPending ? 'Saving...' : 'Save profile'}
        </Button>
      </CardFooter>
    </Card>
  );
}

const PLAN_LABEL: Record<UsageSummary['status'], string> = {
  none: 'Free plan',
  active: 'Pro',
  past_due: 'Pro, payment past due',
  canceled: 'Pro, canceled',
};

function UsageMeter({
  label,
  used,
  cap,
  detail,
  over,
}: {
  label: string;
  used: number;
  /** null renders an empty track: usage is metered, never capped. */
  cap: number | null;
  detail: string;
  over?: boolean;
}) {
  const share = cap === null ? 0 : Math.min(used / Math.max(cap, 1), 1);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{detail}</span>
      </div>
      <span className="h-2.5 bg-muted">
        <span
          className="block h-full"
          style={{
            width: `${share * 100}%`,
            backgroundColor: over ? '#b91c1c' : '#3f3f46',
          }}
        />
      </span>
    </div>
  );
}

function BillingCard() {
  const queryClient = useQueryClient();
  const usageQuery = useQuery({
    queryKey: ['billingUsage'],
    queryFn: api.getBillingUsage,
    enabled: hasCredentials(),
  });

  // Checkout success lands back here with ?billing=success.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing') !== 'success') return;
    toast.success('Subscription active. Welcome to Pro!');
    params.delete('billing');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    void queryClient.invalidateQueries({ queryKey: ['billingUsage'] });
  }, [queryClient]);

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

  const portalMutation = useMutation({
    mutationFn: api.createBillingPortal,
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.status === 404
          ? 'No billing account yet. Upgrade first.'
          : 'Could not open the billing portal.',
      ),
  });

  const usage = usageQuery.data;
  const paid = usage?.status === 'active' || usage?.status === 'past_due';
  const keywordLimit = usage?.status === 'active' ? 500 : 2;

  return (
    <Card>
      <CardHeader className="grid-cols-[1fr_auto] items-center">
        <div className="grid gap-1">
          <CardTitle>Plans and billing</CardTitle>
          <CardDescription>
            EUR 5 per keyword per month. First 100 mentions each month free, then EUR 8 per
            1,000. Every mention we find for your keywords counts.
          </CardDescription>
        </div>
        {usage ? (
          <Badge variant={paid ? 'default' : 'secondary'}>{PLAN_LABEL[usage.status]}</Badge>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        {usage ? (
          <>
            <UsageMeter
              label="Active keywords"
              used={usage.activeKeywords}
              cap={keywordLimit}
              detail={`${usage.activeKeywords} of ${keywordLimit}`}
            />
            <UsageMeter
              label={`Mentions this cycle (${usage.cycle})`}
              used={usage.matchedMentions}
              cap={usage.includedMentions}
              detail={
                usage.overageMentions > 0
                  ? `${usage.matchedMentions} used, ${usage.includedMentions} included, rest metered`
                  : `${usage.matchedMentions} of ${usage.includedMentions} included, then EUR 8 per 1,000. No limit`
              }
              over={usage.overageMentions > 0}
            />
            {usage.overageMentions > 0 ? (
              <p className="text-xs text-muted-foreground">
                {usage.overageMentions} mentions past the free allowance this cycle, billed at
                EUR 0.008 each ({(usage.overageMentions * 0.008).toFixed(2)} EUR so far).
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {hasCredentials() ? 'Loading usage...' : 'Sign in to see usage and plans.'}
          </p>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        {paid ? (
          <Button onClick={() => portalMutation.mutate()} disabled={portalMutation.isPending}>
            {portalMutation.isPending ? 'Opening...' : 'Manage billing'}
          </Button>
        ) : (
          <>
            <Button
              onClick={() => checkoutMutation.mutate()}
              disabled={!hasCredentials() || checkoutMutation.isPending}
            >
              {checkoutMutation.isPending ? 'Starting checkout...' : 'Upgrade to Pro'}
            </Button>
            {usage?.status === 'canceled' ? (
              <Button
                variant="outline"
                onClick={() => portalMutation.mutate()}
                disabled={portalMutation.isPending}
              >
                Billing portal
              </Button>
            ) : null}
          </>
        )}
      </CardFooter>
    </Card>
  );
}

function XSourceCard() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');

  const statusQuery = useQuery({
    queryKey: ['xToken'],
    queryFn: api.getXTokenStatus,
    enabled: hasCredentials(),
  });
  const configured = statusQuery.data?.configured ?? false;

  const saveMutation = useMutation({
    mutationFn: () => api.setXToken(token.trim()),
    onSuccess: () => {
      toast.success('X token saved. Polling picks it up within a few minutes.');
      setToken('');
      void queryClient.invalidateQueries({ queryKey: ['xToken'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save the token'),
  });

  const removeMutation = useMutation({
    mutationFn: api.deleteXToken,
    onSuccess: () => {
      toast.success('X token removed');
      void queryClient.invalidateQueries({ queryKey: ['xToken'] });
    },
    onError: () => toast.error('Failed to remove the token'),
  });

  return (
    <Card>
      <CardHeader className="grid-cols-[1fr_auto] items-center">
        <div className="grid gap-1">
          <CardTitle>X data source</CardTitle>
          <CardDescription>
            Bring your own X API bearer token and your keywords get polled on X with it. Create
            one in the X developer portal (Keys and tokens, Bearer Token; it starts with AAAA).
            Stored server-side and never shown again.
          </CardDescription>
        </div>
        {statusQuery.data ? (
          <Badge variant={configured ? 'default' : 'secondary'}>
            {configured ? 'Connected' : 'Not configured'}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-2">
        <Label htmlFor="x-token">Bearer token</Label>
        <Input
          id="x-token"
          type="password"
          autoComplete="off"
          placeholder={configured ? 'Paste a new token to replace the saved one' : 'AAAA...'}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={!hasCredentials()}
        />
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={!hasCredentials() || token.trim().length < 20 || saveMutation.isPending}
        >
          {saveMutation.isPending ? 'Saving...' : configured ? 'Replace token' : 'Save token'}
        </Button>
        {configured ? (
          <Button
            variant="outline"
            onClick={() => removeMutation.mutate()}
            disabled={removeMutation.isPending}
          >
            Remove
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
