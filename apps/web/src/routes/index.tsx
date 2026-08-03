import type { Keyword, Mention, MentionStats, Source } from '@mentions/core/schemas';
import { SOURCES, sourceSchema } from '@mentions/core/schemas';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { SourceIcon } from '@/components/source-icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, hasCredentials } from '@/lib/api';
import { SOURCE_LABELS, relativeTime } from '@/lib/format';
import { useKeywords } from '@/lib/queries';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/')({ component: HomePage });

const WINDOW_DAYS = 14;

/** Sentiment series, validated with the dataviz palette checker (diverging:
 *  two poles + neutral gray midpoint; green and red are never adjacent in the
 *  stack). Marks only; text always wears text tokens. */
const SERIES = [
  { key: 'positive', label: 'Positive', color: '#047857' },
  { key: 'neutral', label: 'Neutral', color: '#9ca3af' },
  { key: 'negative', label: 'Negative', color: '#b91c1c' },
  { key: 'unclassified', label: 'Unclassified', color: '#d4d4d8' },
] as const;

/** Single hue for one-measure bar lists (sources, keywords). */
const BAR_HUE = '#3f3f46';

const dayTotal = (d: MentionStats['daily'][number]): number =>
  d.positive + d.neutral + d.negative + d.unclassified;

/** Round up to a clean axis maximum (1/2/5 ladder). */
function niceMax(n: number): number {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) {
    if (n <= m * pow) return m * pow;
  }
  return 10 * pow;
}

const dayLabel = (day: string): string =>
  `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

function HomePage() {
  const statsQuery = useQuery({
    queryKey: ['stats', WINDOW_DAYS, 'all', 'all'],
    queryFn: () => api.getStats({ sinceDays: WINDOW_DAYS }),
    enabled: hasCredentials(),
  });
  const recentQuery = useQuery({
    queryKey: ['recentMentions'],
    queryFn: () => api.searchMentions({}),
    enabled: hasCredentials(),
  });
  const keywordsQuery = useKeywords();

  const stats = statsQuery.data;
  const recent = recentQuery.data?.mentions.slice(0, 6) ?? [];
  const activeKeywords = keywordsQuery.data?.keywords.filter((k) => !k.muted).length;

  return (
    <div className="px-6 py-6">
      <PageHeader
        title="Home"
        description={`What happened across your keywords in the last ${WINDOW_DAYS} days.`}
      />

      {statsQuery.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="gap-2 p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
            </Card>
          ))}
        </div>
      ) : stats ? (
        <div className="grid gap-4">
          <StatTiles stats={stats} activeKeywords={activeKeywords} />

          <div className="grid gap-4 lg:grid-cols-3">
            <TrendCard keywords={keywordsQuery.data?.keywords} />

            <Card>
              <CardHeader>
                <CardTitle>Sources</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  items={stats.bySource.map((row) => ({
                    key: row.source,
                    icon: <SourceIcon source={row.source} />,
                    label: SOURCE_LABELS[row.source],
                    count: row.count,
                  }))}
                />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="grid-cols-[1fr_auto] items-center">
                <CardTitle>Recent mentions</CardTitle>
                <Link
                  to="/mentions"
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                >
                  View all
                </Link>
              </CardHeader>
              <CardContent className="grid gap-1">
                {recent.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Nothing here yet.
                  </p>
                ) : (
                  recent.map((mention) => <RecentRow key={mention.id} mention={mention} />)
                )}
              </CardContent>
            </Card>

            <div className="grid gap-4 self-start">
              <Card>
                <CardHeader>
                  <CardTitle>Sentiment</CardTitle>
                </CardHeader>
                <CardContent>
                  <SentimentSplit stats={stats} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Top keywords</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarList
                    items={stats.byKeyword.map((row) => ({
                      key: row.keywordId,
                      label: row.term,
                      count: row.count,
                      mono: true,
                    }))}
                  />
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Sign in or connect an API key to load your dashboard.
        </p>
      )}
    </div>
  );
}

function StatTiles({
  stats,
  activeKeywords,
}: {
  stats: MentionStats;
  activeKeywords: number | undefined;
}) {
  const half = Math.floor(stats.daily.length / 2);
  const prev = stats.daily.slice(0, half).reduce((n, d) => n + dayTotal(d), 0);
  const last = stats.daily.slice(half).reduce((n, d) => n + dayTotal(d), 0);
  const delta = last - prev;
  const classified =
    stats.bySentiment.positive + stats.bySentiment.neutral + stats.bySentiment.negative;
  const positiveShare =
    classified === 0 ? null : Math.round((stats.bySentiment.positive / classified) * 100);

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label={`Mentions (${stats.sinceDays} days)`}
        value={String(stats.total)}
        sub={
          <span className={cn(delta > 0 && 'text-emerald-700', delta < 0 && 'text-red-700')}>
            {delta >= 0 ? '+' : ''}
            {delta} vs prior {half} days
          </span>
        }
      />
      <StatTile
        label="Positive share"
        value={positiveShare === null ? '-' : `${positiveShare}%`}
        sub="of classified mentions"
      />
      <StatTile
        label="Negative mentions"
        value={String(stats.bySentiment.negative)}
        sub="worth a look"
      />
      <StatTile
        label="Active keywords"
        value={activeKeywords === undefined ? '-' : String(activeKeywords)}
        sub="being tracked"
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: React.ReactNode;
}) {
  return (
    <Card className="gap-1 p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </Card>
  );
}

const WINDOW_OPTIONS = [7, 14, 30, 90] as const;
const WINDOW_ITEMS = Object.fromEntries(
  WINDOW_OPTIONS.map((days) => [String(days), `Last ${days} days`]),
);

/** "Mentions over time" with its own filterable stats query. The default
 *  filter state shares a cache entry with the page-level stats query. */
function TrendCard({ keywords }: { keywords: Keyword[] | undefined }) {
  const [days, setDays] = useState<number>(WINDOW_DAYS);
  const [source, setSource] = useState<Source | undefined>(undefined);
  const [keywordId, setKeywordId] = useState<string | undefined>(undefined);

  const query = useQuery({
    queryKey: ['stats', days, source ?? 'all', keywordId ?? 'all'],
    queryFn: () => api.getStats({ sinceDays: days, source, keywordId }),
    enabled: hasCredentials(),
    placeholderData: (previous) => previous,
  });
  const stats = query.data;
  const filtered = source !== undefined || keywordId !== undefined;

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle className="mr-auto">Mentions over time</CardTitle>
        <Select
          items={{ all: 'All sources', ...SOURCE_LABELS }}
          value={source ?? 'all'}
          onValueChange={(value) => {
            const parsed = sourceSchema.safeParse(value);
            setSource(parsed.success ? parsed.data : undefined);
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                <span className="flex items-center gap-2">
                  <SourceIcon source={s} />
                  {SOURCE_LABELS[s]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={{
            all: 'All keywords',
            ...Object.fromEntries((keywords ?? []).map((k) => [k.id, k.term])),
          }}
          value={keywordId ?? 'all'}
          onValueChange={(value) => {
            setKeywordId(value !== null && value !== 'all' ? value : undefined);
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All keywords</SelectItem>
            {(keywords ?? []).map((keyword) => (
              <SelectItem key={keyword.id} value={keyword.id}>
                <span className="font-mono text-xs">{keyword.term}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={WINDOW_ITEMS}
          value={String(days)}
          onValueChange={(value) => {
            const parsed = Number(value);
            if (WINDOW_OPTIONS.some((option) => option === parsed)) setDays(parsed);
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_OPTIONS.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {WINDOW_ITEMS[String(option)]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : !stats || stats.total === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {filtered
              ? 'No mentions match these filters in this window.'
              : 'No mentions in this window yet.'}
          </p>
        ) : (
          <TrendChart daily={stats.daily} />
        )}
      </CardContent>
    </Card>
  );
}

function TrendChart({ daily }: { daily: MentionStats['daily'] }) {
  const max = niceMax(Math.max(1, ...daily.map(dayTotal)));
  const hasUnclassified = daily.some((d) => d.unclassified > 0);
  const series = hasUnclassified ? SERIES : SERIES.slice(0, 3);

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-4">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        <div className="flex h-40 w-7 flex-col justify-between text-right text-[10px] text-muted-foreground">
          <span>{max}</span>
          <span>{max % 2 === 0 ? max / 2 : ''}</span>
          <span>0</span>
        </div>
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-40">
            <div className="absolute inset-x-0 top-0 border-t border-border/60" />
            <div className="absolute inset-x-0 top-1/2 border-t border-border/60" />
            <div className="absolute inset-x-0 bottom-0 border-t border-border" />
          </div>
          <div
            className={cn(
              'relative flex h-40 items-end',
              daily.length > 45 ? 'gap-px' : daily.length > 21 ? 'gap-0.5' : 'gap-1',
            )}
          >
            {daily.map((d) => (
              <div key={d.day} className="group relative flex h-full flex-1 items-end justify-center">
                <div className="flex h-full w-full max-w-6 flex-col justify-end gap-[2px]">
                  {[...SERIES]
                    .reverse() // top segment first; positive sits on the baseline
                    .map((s) =>
                      d[s.key] > 0 ? (
                        <div
                          key={s.key}
                          style={{
                            backgroundColor: s.color,
                            height: `${(d[s.key] / max) * 100}%`,
                          }}
                        />
                      ) : null,
                    )}
                </div>
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 border border-border bg-popover p-2 text-xs whitespace-nowrap shadow-md group-hover:block">
                  <p className="mb-1 font-medium">{dayLabel(d.day)}</p>
                  {SERIES.map((s) =>
                    d[s.key] > 0 ? (
                      <p key={s.key} className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="size-2" style={{ backgroundColor: s.color }} />
                        {s.label}: {d[s.key]}
                      </p>
                    ) : null,
                  )}
                  {dayTotal(d) === 0 ? <p className="text-muted-foreground">No mentions</p> : null}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex text-[10px] text-muted-foreground">
            {daily.map((d, i) => (
              <span key={d.day} className="flex-1 text-center">
                {i === 0 || i === daily.length - 1 || i === Math.floor(daily.length / 2)
                  ? dayLabel(d.day)
                  : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BarList({
  items,
}: {
  items: Array<{
    key: string;
    label: string;
    count: number;
    icon?: React.ReactNode;
    mono?: boolean;
  }>;
}) {
  if (items.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">No data yet.</p>;
  }
  const max = Math.max(...items.map((i) => i.count));
  return (
    <div className="grid gap-2.5">
      {items.map((item) => (
        <div key={item.key} className="flex items-center gap-2 text-xs">
          <span
            className={cn(
              'flex w-28 shrink-0 items-center gap-1.5 truncate',
              item.mono && 'font-mono',
            )}
            title={item.label}
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </span>
          <span className="h-2.5 flex-1 bg-muted">
            <span
              className="block h-full"
              style={{ width: `${(item.count / max) * 100}%`, backgroundColor: BAR_HUE }}
            />
          </span>
          <span className="w-7 text-right text-muted-foreground tabular-nums">{item.count}</span>
        </div>
      ))}
    </div>
  );
}

function SentimentSplit({ stats }: { stats: MentionStats }) {
  const rows = SERIES.filter((s) => s.key !== 'unclassified' || stats.bySentiment.unclassified > 0);
  const total = Math.max(
    1,
    rows.reduce((n, s) => n + stats.bySentiment[s.key], 0),
  );
  return (
    <div className="grid gap-2.5">
      {rows.map((s) => {
        const count = stats.bySentiment[s.key];
        return (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 truncate">{s.label}</span>
            <span className="h-2.5 flex-1 bg-muted">
              <span
                className="block h-full"
                style={{ width: `${(count / total) * 100}%`, backgroundColor: s.color }}
              />
            </span>
            <span className="w-7 text-right text-muted-foreground tabular-nums">{count}</span>
          </div>
        );
      })}
    </div>
  );
}

function RecentRow({ mention }: { mention: Mention }) {
  return (
    <a
      href={mention.url}
      target="_blank"
      rel="noopener noreferrer"
      className="-mx-2 flex min-w-0 items-center gap-2.5 overflow-hidden px-2 py-1.5 text-sm transition-colors hover:bg-muted"
    >
      <SourceIcon source={mention.source} />
      <span className="min-w-0 flex-1 truncate">{mention.text}</span>
      <Badge variant="secondary" className="hidden font-mono text-[10px] sm:inline-flex">
        {mention.keywordTerm}
      </Badge>
      <span className="shrink-0 text-xs text-muted-foreground">
        {relativeTime(mention.publishedAt)}
      </span>
    </a>
  );
}
