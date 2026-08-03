import {
  SOURCES,
  matchStateSchema,
  sentimentSchema,
  sourceSchema,
} from '@mentions/core/schemas';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { LayoutList, Search, Table2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { MentionCard } from '@/components/mention-card';
import { MentionTable } from '@/components/mention-table';
import { PageHeader } from '@/components/page-header';
import { SourceIcon } from '@/components/source-icon';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { SOURCE_LABELS, capitalize } from '@/lib/format';
import { useKeywords } from '@/lib/queries';

const mentionsSearchSchema = z.object({
  q: z.string().optional(),
  source: sourceSchema.optional(),
  state: matchStateSchema.optional(),
  sentiment: sentimentSchema.optional(),
  keywordId: z.string().optional(),
});
type MentionsSearch = z.infer<typeof mentionsSearchSchema>;

export const Route = createFileRoute('/mentions')({
  validateSearch: (search): MentionsSearch => {
    const parsed = mentionsSearchSchema.safeParse(search);
    return parsed.success ? parsed.data : {};
  },
  component: MentionsPage,
});

const STATES = matchStateSchema.options;
const SENTIMENTS = sentimentSchema.options;

type MentionsView = 'cards' | 'table';
const VIEW_STORAGE = 'mentions.view';

const getStoredView = (): MentionsView =>
  localStorage.getItem(VIEW_STORAGE) === 'table' ? 'table' : 'cards';

function MentionsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const keywordsQuery = useKeywords();
  const [view, setView] = useState<MentionsView>(getStoredView);

  const switchView = (next: MentionsView) => {
    setView(next);
    localStorage.setItem(VIEW_STORAGE, next);
  };

  const mentionsQuery = useInfiniteQuery({
    queryKey: ['mentions', search],
    queryFn: ({ pageParam }) => api.searchMentions({ ...search, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const stateMutation = useMutation({
    mutationFn: ({ id, state }: { id: string; state: 'ignored' | 'done' }) =>
      api.setMentionState(id, state),
    onSuccess: (_, vars) => {
      toast.success(vars.state === 'done' ? 'Marked as done' : 'Mention ignored');
      void queryClient.invalidateQueries({ queryKey: ['mentions'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update mention'),
  });

  const setFilters = (patch: Partial<MentionsSearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  };

  const hasFilters = Object.values(search).some((value) => value !== undefined);
  const mentions = mentionsQuery.data?.pages.flatMap((page) => page.mentions) ?? [];
  const keywords = keywordsQuery.data?.keywords ?? [];

  return (
    <div className="px-6 py-6">
      <PageHeader
        title="Mentions"
        description="Everything the pipeline matched for your keywords, newest first."
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8"
            placeholder="Search mention text, press Enter"
            defaultValue={search.q ?? ''}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const value = event.currentTarget.value.trim();
                setFilters({ q: value || undefined });
              }
            }}
          />
        </div>

        <Select
          items={{ all: 'All sources', ...SOURCE_LABELS }}
          value={search.source ?? 'all'}
          onValueChange={(value) => {
            const parsed = sourceSchema.safeParse(value);
            setFilters({ source: parsed.success ? parsed.data : undefined });
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {SOURCES.map((source) => (
              <SelectItem key={source} value={source}>
                <span className="flex items-center gap-2">
                  <SourceIcon source={source} />
                  {SOURCE_LABELS[source]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          items={{
            all: 'All states',
            ...Object.fromEntries(STATES.map((state) => [state, capitalize(state)])),
          }}
          value={search.state ?? 'all'}
          onValueChange={(value) => {
            const parsed = matchStateSchema.safeParse(value);
            setFilters({ state: parsed.success ? parsed.data : undefined });
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            {STATES.map((state) => (
              <SelectItem key={state} value={state}>
                {capitalize(state)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          items={{
            all: 'Any sentiment',
            ...Object.fromEntries(SENTIMENTS.map((s) => [s, capitalize(s)])),
          }}
          value={search.sentiment ?? 'all'}
          onValueChange={(value) => {
            const parsed = sentimentSchema.safeParse(value);
            setFilters({ sentiment: parsed.success ? parsed.data : undefined });
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any sentiment</SelectItem>
            {SENTIMENTS.map((sentiment) => (
              <SelectItem key={sentiment} value={sentiment}>
                {capitalize(sentiment)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {keywords.length > 0 ? (
          <Select
            items={{
              all: 'All keywords',
              ...Object.fromEntries(keywords.map((k) => [k.id, k.term])),
            }}
            value={search.keywordId ?? 'all'}
            onValueChange={(value) =>
              setFilters({ keywordId: value && value !== 'all' ? value : undefined })
            }
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All keywords</SelectItem>
              {keywords.map((keyword) => (
                <SelectItem key={keyword.id} value={keyword.id}>
                  {keyword.term}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void navigate({ search: {}, replace: true })}
          >
            Clear
          </Button>
        ) : null}

        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5">
          <Button
            variant={view === 'cards' ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label="Card view"
            title="Card view"
            onClick={() => switchView('cards')}
          >
            <LayoutList />
          </Button>
          <Button
            variant={view === 'table' ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label="Table view"
            title="Table view"
            onClick={() => switchView('table')}
          >
            <Table2 />
          </Button>
        </div>
      </div>

      {mentionsQuery.isPending ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="gap-3 p-4">
              <div className="flex gap-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-24" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </Card>
          ))}
        </div>
      ) : mentionsQuery.isError ? (
        <QueryError error={mentionsQuery.error} onRetry={() => void mentionsQuery.refetch()} />
      ) : mentions.length === 0 ? (
        <Card className="items-center gap-2 py-12 text-center">
          <p className="font-medium">
            {hasFilters ? 'No mentions match these filters' : 'No mentions yet'}
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {hasFilters
              ? 'Try widening or clearing the filters above.'
              : 'Add keywords and the pipeline will fill this feed as sources are polled.'}
          </p>
        </Card>
      ) : (
        <>
          {view === 'table' ? (
            <MentionTable
              mentions={mentions}
              onSetState={(id, state) => stateMutation.mutate({ id, state })}
            />
          ) : (
            <div className="space-y-3">
              {mentions.map((mention) => (
                <MentionCard
                  key={mention.id}
                  mention={mention}
                  onSetState={(state) => stateMutation.mutate({ id: mention.id, state })}
                />
              ))}
            </div>
          )}
          <div className="mt-6 flex justify-center">
            {mentionsQuery.hasNextPage ? (
              <Button
                variant="outline"
                onClick={() => void mentionsQuery.fetchNextPage()}
                disabled={mentionsQuery.isFetchingNextPage}
              >
                {mentionsQuery.isFetchingNextPage ? 'Loading...' : 'Load more'}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">You are all caught up.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
