/**
 * Tenant-facing mention reads: mention_matches (tenant row) joined to
 * mentions (global deduped row) and keywords, shaped into the Mention schema.
 */
import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client';
import { keywords, mentionMatches, mentions } from '../db/schema';
import type { Mention, SearchMentionsQuery } from '../schemas';

/** Thrown when a pagination cursor fails to decode. API maps it to a 400. */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

export interface MentionsCursor {
  createdAt: number;
  id: string;
}

/** Opaque keyset cursor over (mention_matches.created_at, mention_matches.id). */
export function encodeMentionsCursor(cursor: MentionsCursor): string {
  return btoa(`${cursor.createdAt}:${cursor.id}`);
}

export function decodeMentionsCursor(raw: string): MentionsCursor | null {
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  const createdAt = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isSafeInteger(createdAt) || id.length === 0) return null;
  return { createdAt, id };
}

/** The joined row selection every read shares. */
const mentionSelection = {
  matchId: mentionMatches.id,
  keywordId: mentionMatches.keywordId,
  state: mentionMatches.state,
  relevance: mentionMatches.relevance,
  sentiment: mentionMatches.sentiment,
  intents: mentionMatches.intents,
  aiNote: mentionMatches.aiNote,
  matchCreatedAt: mentionMatches.createdAt,
  source: mentions.source,
  url: mentions.url,
  author: mentions.author,
  authorUrl: mentions.authorUrl,
  text: mentions.text,
  publishedAt: mentions.publishedAt,
  keywordTerm: keywords.term,
};

/** Inferred shape of `mentionSelection` after the two inner joins. */
interface MentionRow {
  matchId: string;
  keywordId: string;
  state: Mention['state'];
  relevance: number | null;
  sentiment: Mention['sentiment'];
  intents: string | null;
  aiNote: string | null;
  matchCreatedAt: number;
  source: string;
  url: string;
  author: string | null;
  authorUrl: string | null;
  text: string;
  publishedAt: number;
  keywordTerm: string;
}

const parseIntents = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

const toMention = (row: MentionRow): Mention => ({
  id: row.matchId,
  source: row.source as Mention['source'],
  url: row.url,
  author: row.author,
  authorUrl: row.authorUrl,
  text: row.text,
  publishedAt: row.publishedAt,
  keywordId: row.keywordId,
  keywordTerm: row.keywordTerm,
  state: row.state,
  relevance: row.relevance,
  sentiment: row.sentiment,
  intents: parseIntents(row.intents),
  aiNote: row.aiNote,
  createdAt: row.matchCreatedAt,
});

/** Escape LIKE wildcards so user input matches literally (pair with ESCAPE '\'). */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function searchMentions(args: {
  db: D1Database;
  orgId: string;
  query: SearchMentionsQuery;
}): Promise<{ mentions: Mention[]; nextCursor: string | null }> {
  const { db, orgId, query } = args;

  const conditions: SQL[] = [eq(mentionMatches.orgId, orgId)];
  if (query.keywordId !== undefined) conditions.push(eq(mentionMatches.keywordId, query.keywordId));
  if (query.source !== undefined) conditions.push(eq(mentions.source, query.source));
  if (query.state !== undefined) conditions.push(eq(mentionMatches.state, query.state));
  if (query.minRelevance !== undefined) conditions.push(gte(mentionMatches.relevance, query.minRelevance));
  if (query.sentiment !== undefined) conditions.push(eq(mentionMatches.sentiment, query.sentiment));
  if (query.intent !== undefined) {
    // intents is a JSON array of double-quoted strings; a quoted LIKE probe is
    // exact enough for the enum-ish intent vocabulary (MVP, no json_each).
    conditions.push(sql`${mentionMatches.intents} LIKE ${`%"${escapeLike(query.intent)}"%`} ESCAPE '\\'`);
  }
  if (query.q !== undefined) {
    conditions.push(sql`${mentions.text} LIKE ${`%${escapeLike(query.q)}%`} ESCAPE '\\'`);
  }
  if (query.since !== undefined) conditions.push(gte(mentions.publishedAt, query.since));
  if (query.until !== undefined) conditions.push(lte(mentions.publishedAt, query.until));
  if (query.cursor !== undefined) {
    const cursor = decodeMentionsCursor(query.cursor);
    if (!cursor) throw new InvalidCursorError();
    const keyset = or(
      lt(mentionMatches.createdAt, cursor.createdAt),
      and(eq(mentionMatches.createdAt, cursor.createdAt), lt(mentionMatches.id, cursor.id)),
    );
    if (keyset) conditions.push(keyset);
  }

  // Fetch one extra row to know whether a next page exists.
  const results = await getDb(db)
    .select(mentionSelection)
    .from(mentionMatches)
    .innerJoin(mentions, eq(mentions.id, mentionMatches.mentionId))
    .innerJoin(keywords, eq(keywords.id, mentionMatches.keywordId))
    .where(and(...conditions))
    .orderBy(desc(mentionMatches.createdAt), desc(mentionMatches.id))
    .limit(query.limit + 1);

  const hasMore = results.length > query.limit;
  const page = hasMore ? results.slice(0, query.limit) : results;
  const last = page.length > 0 ? page[page.length - 1] : undefined;
  const nextCursor =
    hasMore && last ? encodeMentionsCursor({ createdAt: last.matchCreatedAt, id: last.matchId }) : null;

  return { mentions: page.map(toMention), nextCursor };
}

export async function getMention(args: {
  db: D1Database;
  orgId: string;
  mentionMatchId: string;
}): Promise<Mention | null> {
  const row = await getDb(args.db)
    .select(mentionSelection)
    .from(mentionMatches)
    .innerJoin(mentions, eq(mentions.id, mentionMatches.mentionId))
    .innerJoin(keywords, eq(keywords.id, mentionMatches.keywordId))
    .where(and(eq(mentionMatches.id, args.mentionMatchId), eq(mentionMatches.orgId, args.orgId)))
    .get();
  return row ? toMention(row) : null;
}

/** Users may only park a mention ('ignored') or close it ('done'); pipeline
 *  states (matched/classified/filtered/delivered) are set by the pipeline. */
export async function setMentionState(args: {
  db: D1Database;
  orgId: string;
  mentionMatchId: string;
  state: 'ignored' | 'done';
}): Promise<boolean> {
  const result = await getDb(args.db)
    .update(mentionMatches)
    .set({ state: args.state })
    .where(and(eq(mentionMatches.id, args.mentionMatchId), eq(mentionMatches.orgId, args.orgId)));
  return (result.meta.changes ?? 0) > 0;
}
