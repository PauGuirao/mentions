import type { OnboardingAnalyzeResponse } from '@mentions/core/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Globe, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
});

const ANALYZE_STATUS = [
  'Reading your site...',
  'Working out what you do...',
  'Identifying your market...',
  'Finding likely competitors...',
  'Drafting keyword suggestions...',
];

/** Users type "acme.com"; the API wants a real URL. */
function normalizeWebsite(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function AnalyzeStatus() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndex((i) => (i + 1) % ANALYZE_STATUS.length), 2200);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {ANALYZE_STATUS[index]}
    </span>
  );
}

function TermChips({
  label,
  hint,
  terms,
  onChange,
  addPlaceholder,
}: {
  label: string;
  hint: string;
  terms: string[];
  onChange: (terms: string[]) => void;
  addPlaceholder: string;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const term = draft.trim();
    if (term.length < 2) return;
    if (terms.some((t) => t.toLowerCase() === term.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...terms, term.slice(0, 80)]);
    setDraft('');
  };

  return (
    <div className="grid gap-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {terms.map((term) => (
          <Badge key={term} variant="secondary" className="h-6 gap-1 pr-1 font-mono text-xs">
            {term}
            <button
              type="button"
              aria-label={`Remove ${term}`}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
              onClick={() => onChange(terms.filter((t) => t !== term))}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <Input
          className="h-6 w-36 border-dashed px-2 text-xs"
          placeholder={addPlaceholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      </div>
    </div>
  );
}

function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [website, setWebsite] = useState('');
  const [analysis, setAnalysis] = useState<OnboardingAnalyzeResponse | null>(null);

  // Review-step state, seeded from the analysis and fully editable.
  const [brandName, setBrandName] = useState('');
  const [brandTerms, setBrandTerms] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [competitors, setCompetitors] = useState<string[]>([]);
  const [context, setContext] = useState('');

  const analyzeMutation = useMutation({
    mutationFn: (url: string) => api.analyzeWebsite(url),
    onSuccess: (data) => {
      setAnalysis(data);
      setBrandName(data.brandName);
      setBrandTerms([data.brandName.toLowerCase()]);
      setTopics(data.topics);
      setCompetitors(data.competitors);
      setContext(data.context);
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not analyze that website'),
  });

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    await queryClient.invalidateQueries({ queryKey: ['keywords'] });
    await navigate({ to: '/mentions' });
  };

  const completeMutation = useMutation({
    mutationFn: () => {
      if (!analysis) throw new Error('Analyze a website first');
      return api.completeOnboarding({
        website: analysis.website,
        brandName: brandName.trim() || analysis.brandName,
        logoUrl: analysis.logoUrl,
        context,
        keywords: [
          ...brandTerms.map((term) => ({ term, kind: 'brand' as const })),
          ...topics.map((term) => ({ term, kind: 'topic' as const })),
          ...competitors.map((term) => ({ term, kind: 'competitor' as const })),
        ].filter((k) => k.term.trim().length >= 2),
      });
    },
    onSuccess: () => void finish(),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not save your brand'),
  });

  const skipMutation = useMutation({
    mutationFn: () => {
      const url = normalizeWebsite(website);
      let host = 'My brand';
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        // finish() below never runs; the API rejects the invalid URL first.
      }
      return api.completeOnboarding({ website: url, brandName: host, keywords: [] });
    },
    onSuccess: () => void finish(),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Enter a valid website URL first'),
  });

  const analyze = () => {
    const url = normalizeWebsite(website);
    if (url === '') {
      toast.error('Enter your website URL');
      return;
    }
    analyzeMutation.mutate(url);
  };

  const pending = completeMutation.isPending || skipMutation.isPending;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-8">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
              @
            </span>
            <span className="font-semibold tracking-tight">Mentions</span>
          </div>
          {analysis === null ? (
            <>
              <CardTitle>What is your website?</CardTitle>
              <CardDescription>
                We will read it to learn about your brand, your market and your competitors, then
                suggest the keywords to track.
              </CardDescription>
            </>
          ) : (
            <>
              <CardTitle>Here is your brand</CardTitle>
              <CardDescription>
                Review the suggestions. Everything is editable, and you can change it later in
                Settings.
              </CardDescription>
            </>
          )}
        </CardHeader>

        {analysis === null ? (
          <>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="website">Website</Label>
                <div className="relative">
                  <Globe className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="website"
                    className="pl-8"
                    placeholder="yourcompany.com"
                    autoFocus
                    value={website}
                    onChange={(event) => setWebsite(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') analyze();
                    }}
                    disabled={analyzeMutation.isPending}
                  />
                </div>
              </div>
              {analyzeMutation.isPending ? <AnalyzeStatus /> : null}
            </CardContent>
            <CardFooter className="grid gap-3">
              <Button
                className="w-full"
                onClick={analyze}
                disabled={analyzeMutation.isPending || website.trim() === ''}
              >
                {analyzeMutation.isPending ? 'Analyzing...' : 'Analyze my website'}
              </Button>
              <button
                type="button"
                className="text-center text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
                onClick={() => skipMutation.mutate()}
                disabled={pending || website.trim() === ''}
              >
                Skip for now
              </button>
            </CardFooter>
          </>
        ) : (
          <>
            <CardContent className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="brand-name">Brand name</Label>
                <div className="flex items-center gap-2">
                  {analysis.logoUrl ? (
                    <img
                      src={analysis.logoUrl}
                      alt=""
                      className="size-8 shrink-0 rounded-md border border-border object-contain"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : null}
                  <Input
                    id="brand-name"
                    value={brandName}
                    onChange={(event) => setBrandName(event.target.value)}
                  />
                </div>
              </div>

              <TermChips
                label="Brand keywords"
                hint="Mentions of your own brand and product names."
                terms={brandTerms}
                onChange={setBrandTerms}
                addPlaceholder="Add brand term"
              />
              <TermChips
                label="Topic keywords"
                hint="Your space, activity or product category."
                terms={topics}
                onChange={setTopics}
                addPlaceholder="Add topic"
              />
              <TermChips
                label="Competitors"
                hint="We will track their mentions alongside yours."
                terms={competitors}
                onChange={setCompetitors}
                addPlaceholder="Add competitor"
              />

              <div className="grid gap-2">
                <Label htmlFor="context">About your company</Label>
                <Textarea
                  id="context"
                  rows={4}
                  maxLength={4000}
                  value={context}
                  onChange={(event) => setContext(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Fed to the relevance classifier. The better this is, the better your feed gets.
                </p>
              </div>
            </CardContent>
            <CardFooter className="grid gap-3">
              <Button className="w-full" onClick={() => completeMutation.mutate()} disabled={pending}>
                {completeMutation.isPending ? 'Setting up...' : 'Continue to dashboard'}
              </Button>
              <button
                type="button"
                className="text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => setAnalysis(null)}
                disabled={pending}
              >
                Analyze a different website
              </button>
            </CardFooter>
          </>
        )}
      </Card>
    </div>
  );
}
