/**
 * Mention aggregates for the dashboard and the MCP get_mention_stats tool.
 * All windows are on mentions.published_at (when the post happened, not when
 * we ingested it); days are UTC buckets, zero-filled so charts get a full
 * series.
 */
import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client';
import { keywords, mentionMatches, mentions } from '../db/schema';
import type { MentionStats, Source } from '../schemas';
import { SOURCES } from '../schemas';

const DAY_MS = 86_400_000;

const dayKey = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

type SentimentBucket = 'positive' | 'neutral' | 'negative' | 'unclassified';
const toBucket = (sentiment: string | null): SentimentBucket =>
  sentiment === 'positive' || sentiment === 'neutral' || sentiment === 'negative'
    ? sentiment
    : 'unclassified';

export async function getMentionStats(args: {
  db: D1Database;
  orgId: string;
  sinceDays: number;
  /** Restrict every aggregate to one source platform. */
  source?: Source | undefined;
  /** Restrict every aggregate to one tracked keyword. */
  keywordId?: string | undefined;
}): Promise<MentionStats> {
  const { db, orgId, sinceDays, source, keywordId } = args;
  const orm = getDb(db);
  const now = Date.now();
  const since = now - sinceDays * DAY_MS;

  const conditions: SQL[] = [eq(mentionMatches.orgId, orgId), gte(mentions.publishedAt, since)];
  if (source !== undefined) conditions.push(eq(mentions.source, source));
  if (keywordId !== undefined) conditions.push(eq(mentionMatches.keywordId, keywordId));
  const where = and(...conditions);

  const count = sql<number>`COUNT(*)`;
  const [byDay, bySource, byKeyword] = await Promise.all([
    orm
      .select({
        day: sql<string>`strftime('%Y-%m-%d', ${mentions.publishedAt} / 1000, 'unixepoch')`.as('day'),
        sentiment: mentionMatches.sentiment,
        n: count.as('n'),
      })
      .from(mentionMatches)
      .innerJoin(mentions, eq(mentions.id, mentionMatches.mentionId))
      .where(where)
      .groupBy(sql`day`, mentionMatches.sentiment),
    orm
      .select({ source: mentions.source, n: count.as('n') })
      .from(mentionMatches)
      .innerJoin(mentions, eq(mentions.id, mentionMatches.mentionId))
      .where(where)
      .groupBy(mentions.source)
      .orderBy(desc(sql`n`)),
    orm
      .select({ keywordId: keywords.id, term: keywords.term, n: count.as('n') })
      .from(mentionMatches)
      .innerJoin(mentions, eq(mentions.id, mentionMatches.mentionId))
      .innerJoin(keywords, eq(keywords.id, mentionMatches.keywordId))
      .where(where)
      .groupBy(keywords.id)
      .orderBy(desc(sql`n`))
      .limit(8),
  ]);

  // Zero-filled UTC day series, oldest first, ending today.
  const daily = new Map<string, MentionStats['daily'][number]>();
  for (let i = sinceDays - 1; i >= 0; i--) {
    const day = dayKey(now - i * DAY_MS);
    daily.set(day, { day, positive: 0, neutral: 0, negative: 0, unclassified: 0 });
  }
  const bySentiment = { positive: 0, neutral: 0, negative: 0, unclassified: 0 };
  let total = 0;
  for (const row of byDay) {
    const bucket = toBucket(row.sentiment);
    bySentiment[bucket] += row.n;
    total += row.n;
    const entry = daily.get(row.day);
    if (entry) entry[bucket] += row.n;
  }

  return {
    sinceDays,
    total,
    bySentiment,
    bySource: bySource
      .filter((row): row is { source: Source; n: number } =>
        (SOURCES as readonly string[]).includes(row.source),
      )
      .map((row) => ({ source: row.source, count: row.n })),
    byKeyword: byKeyword.map((row) => ({
      keywordId: row.keywordId,
      term: row.term,
      count: row.n,
    })),
    daily: [...daily.values()],
  };
}
