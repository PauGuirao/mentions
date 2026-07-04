/**
 * Tenant-facing mention reads: mention_matches (tenant row) joined to
 * mentions (global deduped row) and keywords, shaped into the Mention schema.
 */
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

interface MentionRow {
  match_id: string;
  source: Mention['source'];
  url: string;
  author: string | null;
  author_url: string | null;
  text: string;
  published_at: number;
  keyword_id: string;
  keyword_term: string;
  state: Mention['state'];
  relevance: number | null;
  sentiment: Mention['sentiment'];
  intents: string | null;
  ai_note: string | null;
  match_created_at: number;
}

const BASE_SELECT = `
SELECT
  mm.id AS match_id, mm.keyword_id, mm.state, mm.relevance, mm.sentiment,
  mm.intents, mm.ai_note, mm.created_at AS match_created_at,
  m.source, m.url, m.author, m.author_url, m.text, m.published_at,
  k.term AS keyword_term
FROM mention_matches mm
JOIN mentions m ON m.id = mm.mention_id
JOIN keywords k ON k.id = mm.keyword_id`;

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
  id: row.match_id,
  source: row.source,
  url: row.url,
  author: row.author,
  authorUrl: row.author_url,
  text: row.text,
  publishedAt: row.published_at,
  keywordId: row.keyword_id,
  keywordTerm: row.keyword_term,
  state: row.state,
  relevance: row.relevance,
  sentiment: row.sentiment,
  intents: parseIntents(row.intents),
  aiNote: row.ai_note,
  createdAt: row.match_created_at,
});

/** Escape LIKE wildcards so user input matches literally (pair with ESCAPE '\'). */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function searchMentions(args: {
  db: D1Database;
  orgId: string;
  query: SearchMentionsQuery;
}): Promise<{ mentions: Mention[]; nextCursor: string | null }> {
  const { db, orgId, query } = args;

  const where: string[] = ['mm.org_id = ?'];
  const params: Array<string | number> = [orgId];

  if (query.keywordId !== undefined) {
    where.push('mm.keyword_id = ?');
    params.push(query.keywordId);
  }
  if (query.source !== undefined) {
    where.push('m.source = ?');
    params.push(query.source);
  }
  if (query.state !== undefined) {
    where.push('mm.state = ?');
    params.push(query.state);
  }
  if (query.minRelevance !== undefined) {
    where.push('mm.relevance >= ?');
    params.push(query.minRelevance);
  }
  if (query.sentiment !== undefined) {
    where.push('mm.sentiment = ?');
    params.push(query.sentiment);
  }
  if (query.intent !== undefined) {
    // intents is a JSON array of double-quoted strings; a quoted LIKE probe is
    // exact enough for the enum-ish intent vocabulary (MVP, no json_each).
    where.push("mm.intents LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(query.intent)}"%`);
  }
  if (query.q !== undefined) {
    where.push("m.text LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.q)}%`);
  }
  if (query.since !== undefined) {
    where.push('m.published_at >= ?');
    params.push(query.since);
  }
  if (query.until !== undefined) {
    where.push('m.published_at <= ?');
    params.push(query.until);
  }
  if (query.cursor !== undefined) {
    const cursor = decodeMentionsCursor(query.cursor);
    if (!cursor) throw new InvalidCursorError();
    where.push('(mm.created_at < ? OR (mm.created_at = ? AND mm.id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const sql = `${BASE_SELECT}
WHERE ${where.join(' AND ')}
ORDER BY mm.created_at DESC, mm.id DESC
LIMIT ?`;

  // Fetch one extra row to know whether a next page exists.
  const { results } = await db
    .prepare(sql)
    .bind(...params, query.limit + 1)
    .all<MentionRow>();

  const hasMore = results.length > query.limit;
  const page = hasMore ? results.slice(0, query.limit) : results;
  const last = page.length > 0 ? page[page.length - 1] : undefined;
  const nextCursor =
    hasMore && last ? encodeMentionsCursor({ createdAt: last.match_created_at, id: last.match_id }) : null;

  return { mentions: page.map(toMention), nextCursor };
}

export async function getMention(args: {
  db: D1Database;
  orgId: string;
  mentionMatchId: string;
}): Promise<Mention | null> {
  const row = await args.db
    .prepare(`${BASE_SELECT}\nWHERE mm.id = ? AND mm.org_id = ?`)
    .bind(args.mentionMatchId, args.orgId)
    .first<MentionRow>();
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
  const result = await args.db
    .prepare('UPDATE mention_matches SET state = ? WHERE id = ? AND org_id = ?')
    .bind(args.state, args.mentionMatchId, args.orgId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
