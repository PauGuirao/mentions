import type { Mention } from '@mentions/core/schemas';
import {
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  EyeOff,
  ExternalLink,
  MoreHorizontal,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SourceIcon } from '@/components/source-icon';
import { SOURCE_LABELS, capitalize, fullDate, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const SENTIMENT_DOT: Record<string, string> = {
  positive: 'bg-emerald-500',
  neutral: 'bg-zinc-400',
  negative: 'bg-red-500',
};

const SENTIMENT_RANK: Record<string, number> = { negative: 0, neutral: 1, positive: 2 };

type SortKey = 'source' | 'keyword' | 'author' | 'sentiment' | 'relevance' | 'state' | 'date';
interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

function sortValue(mention: Mention, key: SortKey): string | number {
  switch (key) {
    case 'source':
      return SOURCE_LABELS[mention.source];
    case 'keyword':
      return mention.keywordTerm;
    case 'author':
      return mention.author?.toLowerCase() ?? '';
    case 'sentiment':
      return mention.sentiment ? (SENTIMENT_RANK[mention.sentiment] ?? -1) : -1;
    case 'relevance':
      return mention.relevance ?? -1;
    case 'state':
      return mention.state;
    case 'date':
      return mention.publishedAt;
  }
}

function SortableHead({
  label,
  sortKey,
  sort,
  onSort,
  className,
  align,
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort | null;
  onSort: (key: SortKey) => void;
  className?: string;
  align?: 'right';
}) {
  const active = sort?.key === sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        className={cn(
          '-mx-1 flex items-center gap-1 px-1 transition-colors hover:text-foreground/70',
          align === 'right' && 'ml-auto',
        )}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <Icon className={cn('size-3.5', active ? '' : 'text-muted-foreground/50')} />
      </button>
    </TableHead>
  );
}

export function MentionTable({
  mentions,
  onSetState,
}: {
  mentions: Mention[];
  onSetState: (id: string, state: 'ignored' | 'done') => void;
}) {
  // null = the feed's own order (newest first from the API).
  const [sort, setSort] = useState<Sort | null>(null);

  // Click cycles a column: ascending, then descending, then back to default.
  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  };

  const sorted = useMemo(() => {
    if (!sort) return mentions;
    const { key, dir } = sort;
    return [...mentions].sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      const cmp =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb));
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [mentions, sort]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <SortableHead label="Source" sortKey="source" sort={sort} onSort={toggleSort} />
            <TableHead className="w-full">Mention</TableHead>
            <SortableHead label="Keyword" sortKey="keyword" sort={sort} onSort={toggleSort} />
            <SortableHead label="Author" sortKey="author" sort={sort} onSort={toggleSort} />
            <SortableHead label="Sentiment" sortKey="sentiment" sort={sort} onSort={toggleSort} />
            <SortableHead
              label="Rel"
              sortKey="relevance"
              sort={sort}
              onSort={toggleSort}
              align="right"
              className="text-right"
            />
            <SortableHead label="State" sortKey="state" sort={sort} onSort={toggleSort} />
            <SortableHead label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
            <TableHead aria-label="Actions" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((mention) => (
            <TableRow
              key={mention.id}
              className={cn(mention.state === 'ignored' && 'opacity-60')}
            >
              <TableCell>
                <span className="flex items-center gap-1.5">
                  <SourceIcon source={mention.source} />
                  {SOURCE_LABELS[mention.source]}
                </span>
              </TableCell>
              <TableCell className="max-w-0 whitespace-normal">
                <a
                  href={mention.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={mention.text}
                  className="line-clamp-2 hover:text-foreground/80"
                >
                  {mention.text}
                </a>
              </TableCell>
              <TableCell>
                <Badge variant="secondary" className="font-mono text-xs">
                  {mention.keywordTerm}
                </Badge>
              </TableCell>
              <TableCell className="max-w-32 truncate text-muted-foreground">
                {mention.author ?? ''}
              </TableCell>
              <TableCell>
                {mention.sentiment ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className={cn('size-1.5 rounded-full', SENTIMENT_DOT[mention.sentiment])}
                    />
                    {capitalize(mention.sentiment)}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-right font-mono text-muted-foreground">
                {mention.relevance ?? ''}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{capitalize(mention.state)}</Badge>
              </TableCell>
              <TableCell
                className="text-muted-foreground"
                title={fullDate(mention.publishedAt)}
              >
                {relativeTime(mention.publishedAt)}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label="Mention actions" />}
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-auto">
                    <DropdownMenuItem
                      onClick={() => window.open(mention.url, '_blank', 'noopener,noreferrer')}
                    >
                      <ExternalLink /> Open original
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onSetState(mention.id, 'done')}>
                      <Check /> Mark as done
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onSetState(mention.id, 'ignored')}>
                      <EyeOff /> Ignore
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
