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

        <CompanyProfileCard />
      </div>
    </div>
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
