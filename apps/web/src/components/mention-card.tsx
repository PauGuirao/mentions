import type { Mention } from '@mentions/core/schemas';
import { Check, EyeOff, ExternalLink, MoreHorizontal, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SOURCE_LABELS, capitalize, fullDate, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const SENTIMENT_DOT: Record<string, string> = {
  positive: 'bg-emerald-500',
  neutral: 'bg-zinc-400',
  negative: 'bg-red-500',
};

export function MentionCard({
  mention,
  onSetState,
}: {
  mention: Mention;
  onSetState: (state: 'ignored' | 'done') => void;
}) {
  const closed = mention.state === 'ignored' || mention.state === 'done';
  return (
    <Card className={cn('gap-2.5 p-4', mention.state === 'ignored' && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <Badge variant="outline">{SOURCE_LABELS[mention.source]}</Badge>
        <Badge variant="secondary" className="font-mono text-xs">
          {mention.keywordTerm}
        </Badge>
        {closed ? <Badge variant="outline">{capitalize(mention.state)}</Badge> : null}
        <span className="ml-auto text-xs text-muted-foreground" title={fullDate(mention.publishedAt)}>
          {relativeTime(mention.publishedAt)}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Mention actions" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => window.open(mention.url, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink /> Open original
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onSetState('done')}>
              <Check /> Mark as done
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSetState('ignored')}>
              <EyeOff /> Ignore
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <a href={mention.url} target="_blank" rel="noopener noreferrer" className="group">
        <p className="line-clamp-4 text-sm leading-relaxed whitespace-pre-line group-hover:text-foreground/90">
          {mention.text}
        </p>
      </a>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {mention.author ? (
          mention.authorUrl ? (
            <a
              href={mention.authorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              {mention.author}
            </a>
          ) : (
            <span>{mention.author}</span>
          )
        ) : null}
        {mention.sentiment ? (
          <span className="flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', SENTIMENT_DOT[mention.sentiment])} />
            {capitalize(mention.sentiment)}
          </span>
        ) : null}
        {mention.relevance !== null ? (
          <span className="font-mono" title="Relevance score (0-100)">
            rel {mention.relevance}
          </span>
        ) : null}
        {mention.intents.map((intent) => (
          <Badge key={intent} variant="outline" className="text-[10px]">
            {intent.replace('_', ' ')}
          </Badge>
        ))}
      </div>

      {mention.aiNote ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground italic">
          <Sparkles className="mt-0.5 size-3 shrink-0" />
          {mention.aiNote}
        </p>
      ) : null}
    </Card>
  );
}
