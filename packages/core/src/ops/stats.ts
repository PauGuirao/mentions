/**
 * Mention aggregates for the dashboard and the MCP get_mention_stats tool.
 * All windows are on mentions.published_at (when the post happened, not when
 * we ingested it); days are UTC buckets, zero-filled so charts get a full
 * series.
 */
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
  const now = Date.now();
  const since = now - sinceDays * DAY_MS;

  const conditions = ['mm.org_id = ?1', 'm.published_at >= ?2'];
  const params: Array<string | number> = [orgId, since];
  if (source !== undefined) {
    params.push(source);
    conditions.push(`m.source = ?${params.length}`);
  }
  if (keywordId !== undefined) {
    params.push(keywordId);
    conditions.push(`mm.keyword_id = ?${params.length}`);
  }
  const where = conditions.join(' AND ');

  const [byDay, bySource, byKeyword] = await Promise.all([
    db
      .prepare(
        `SELECT strftime('%Y-%m-%d', m.published_at / 1000, 'unixepoch') AS day,
                mm.sentiment AS sentiment, COUNT(*) AS n
         FROM mention_matches mm JOIN mentions m ON m.id = mm.mention_id
         WHERE ${where}
         GROUP BY day, mm.sentiment`,
      )
      .bind(...params)
      .all<{ day: string; sentiment: string | null; n: number }>(),
    db
      .prepare(
        `SELECT m.source AS source, COUNT(*) AS n
         FROM mention_matches mm JOIN mentions m ON m.id = mm.mention_id
         WHERE ${where}
         GROUP BY m.source ORDER BY n DESC`,
      )
      .bind(...params)
      .all<{ source: string; n: number }>(),
    db
      .prepare(
        `SELECT k.id AS keyword_id, k.term AS term, COUNT(*) AS n
         FROM mention_matches mm
         JOIN mentions m ON m.id = mm.mention_id
         JOIN keywords k ON k.id = mm.keyword_id
         WHERE ${where}
         GROUP BY k.id ORDER BY n DESC LIMIT 8`,
      )
      .bind(...params)
      .all<{ keyword_id: string; term: string; n: number }>(),
  ]);

  // Zero-filled UTC day series, oldest first, ending today.
  const daily = new Map<string, MentionStats['daily'][number]>();
  for (let i = sinceDays - 1; i >= 0; i--) {
    const day = dayKey(now - i * DAY_MS);
    daily.set(day, { day, positive: 0, neutral: 0, negative: 0, unclassified: 0 });
  }
  const bySentiment = { positive: 0, neutral: 0, negative: 0, unclassified: 0 };
  let total = 0;
  for (const row of byDay.results) {
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
    bySource: bySource.results
      .filter((row): row is { source: Source; n: number } =>
        (SOURCES as readonly string[]).includes(row.source),
      )
      .map((row) => ({ source: row.source, count: row.n })),
    byKeyword: byKeyword.results.map((row) => ({
      keywordId: row.keyword_id,
      term: row.term,
      count: row.n,
    })),
    daily: [...daily.values()],
  };
}
