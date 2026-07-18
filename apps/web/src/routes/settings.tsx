import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api, getApiKey, getApiUrl, hasApiKey, hasCredentials, setApiKey, setApiUrl } from '@/lib/api';

export const Route = createFileRoute('/settings')({ component: SettingsPage });

const CONTEXT_MAX = 4000;

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
    <div className="mx-auto max-w-3xl px-8 py-8">
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

        <CompanyContextCard />
      </div>
    </div>
  );
}

function CompanyContextCard() {
  const queryClient = useQueryClient();
  const [context, setContext] = useState('');
  const contextQuery = useQuery({
    queryKey: ['company'],
    queryFn: api.getCompanyContext,
    enabled: hasCredentials(),
  });

  useEffect(() => {
    if (contextQuery.data) setContext(contextQuery.data.context);
  }, [contextQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => api.setCompanyContext(context),
    onSuccess: () => {
      toast.success('Company context saved');
      void queryClient.invalidateQueries({ queryKey: ['company'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save context'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Company context</CardTitle>
        <CardDescription>
          What your company does, products, competitors. Fed verbatim to the classifier; the
          single biggest relevance lever.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Textarea
          rows={8}
          maxLength={CONTEXT_MAX}
          placeholder={
            hasCredentials()
              ? 'We build X for Y. Our products are... Our competitors are...'
              : 'Sign in or connect an API key to edit the company context.'
          }
          value={context}
          onChange={(event) => setContext(event.target.value)}
          disabled={!hasCredentials() || contextQuery.isLoading}
        />
        <p className="text-right text-xs text-muted-foreground">
          {context.length}/{CONTEXT_MAX}
        </p>
      </CardContent>
      <CardFooter>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={!hasCredentials() || saveMutation.isPending}
        >
          {saveMutation.isPending ? 'Saving...' : 'Save context'}
        </Button>
      </CardFooter>
    </Card>
  );
}
