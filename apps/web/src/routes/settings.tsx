import type { CompanyProfile } from '@mentions/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
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

        <SlackCard />

        <CompanyProfileCard />
      </div>
    </div>
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

  // Seed the form from the saved config once status arrives.
  useEffect(() => {
    const saved = statusQuery.data?.notifications;
    if (!saved) return;
    setChannelId(saved.channelId);
    setMinRelevance(saved.minRelevance === null ? '0' : String(saved.minRelevance));
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
