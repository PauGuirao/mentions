/**
 * Keyword operations. Pure functions over D1: the REST API, the MCP server,
 * the matcher and the scheduler all call through here (invariant: no product
 * logic in worker handlers).
 */
import { newId } from '../ids';
import { normalizeTerm } from '../match';
import type { Keyword } from '../schemas';

/** Thrown when (org_id, normalized_term) already exists for the org. */
export class DuplicateKeywordError extends Error {
  constructor(term: string) {
    super(`Keyword "${term}" already exists for this org`);
    this.name = 'DuplicateKeywordError';
  }
}

interface KeywordRow {
  id: string;
  term: string;
  kind: Keyword['kind'];
  muted: number;
  created_at: number;
}

const toKeyword = (row: KeywordRow): Keyword => ({
  id: row.id,
  term: row.term,
  kind: row.kind,
  muted: row.muted === 1,
  createdAt: row.created_at,
});

export async function createKeyword(args: {
  db: D1Database;
  orgId: string;
  term: string;
  kind: 'brand' | 'competitor' | 'topic';
}): Promise<Keyword> {
  const { db, orgId, term, kind } = args;
  const id = newId('kw');
  const createdAt = Date.now();
  try {
    await db
      .prepare(
        'INSERT INTO keywords (id, org_id, term, normalized_term, kind, muted, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      )
      .bind(id, orgId, term, normalizeTerm(term), kind, createdAt)
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw new DuplicateKeywordError(term);
    }
    throw err;
  }
  return { id, term, kind, muted: false, createdAt };
}

export async function listKeywords(args: { db: D1Database; orgId: string }): Promise<Keyword[]> {
  const { results } = await args.db
    .prepare('SELECT id, term, kind, muted, created_at FROM keywords WHERE org_id = ? ORDER BY created_at DESC')
    .bind(args.orgId)
    .all<KeywordRow>();
  return results.map(toKeyword);
}

/** D1 caps bound parameters at 100 per statement; chunk orphan-id deletes
 *  under that so removing a keyword with many exclusive matches still works. */
const ORPHAN_DELETE_CHUNK = 90;

export async function deleteKeyword(args: {
  db: D1Database;
  orgId: string;
  keywordId: string;
}): Promise<boolean> {
  const { db, orgId, keywordId } = args;

  // A mention is global and reachable only through mention_matches. Once this
  // keyword's matches are gone, any mention matched by nothing else is
  // orphaned in the mentions table forever. Collect those ids first (while the
  // matches still exist to read); a mention still matched by another
  // keyword/org is excluded and left in place.
  const { results: orphans } = await db
    .prepare(
      `SELECT mm.mention_id AS id FROM mention_matches mm
       WHERE mm.org_id = ? AND mm.keyword_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM mention_matches other
           WHERE other.mention_id = mm.mention_id
             AND NOT (other.org_id = ? AND other.keyword_id = ?)
         )`,
    )
    .bind(orgId, keywordId, orgId, keywordId)
    .all<{ id: string }>();

  // mention_matches carries plain FKs on both keyword_id and mention_id (no ON
  // DELETE CASCADE), so within the batch the matches must be deleted before
  // both the keyword and the orphaned mentions, or D1 rejects the parent
  // delete. If a concurrent match lands on an orphan between the read above and
  // this batch, the FK makes the mention delete fail and rolls the batch back
  // (fail closed, no dangling row) — a retry then sees the mention as non-orphan.
  const statements = [
    db.prepare('DELETE FROM mention_matches WHERE org_id = ? AND keyword_id = ?').bind(orgId, keywordId),
    db.prepare('DELETE FROM keywords WHERE id = ? AND org_id = ?').bind(keywordId, orgId),
  ];
  for (let i = 0; i < orphans.length; i += ORPHAN_DELETE_CHUNK) {
    const ids = orphans.slice(i, i + ORPHAN_DELETE_CHUNK).map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    statements.push(db.prepare(`DELETE FROM mentions WHERE id IN (${placeholders})`).bind(...ids));
  }

  const results = await db.batch(statements);
  // results[1] is the keyword delete; its change count is the existence signal.
  return (results[1]?.meta.changes ?? 0) > 0;
}

export async function setKeywordMuted(args: {
  db: D1Database;
  orgId: string;
  keywordId: string;
  muted: boolean;
}): Promise<boolean> {
  const result = await args.db
    .prepare('UPDATE keywords SET muted = ? WHERE id = ? AND org_id = ?')
    .bind(args.muted ? 1 : 0, args.keywordId, args.orgId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Every unmuted keyword across ALL orgs, grouped by normalized term. The
 * scheduler polls search-API sources once per entry; the matcher fans a hit
 * back out to every subscriber (invariant: ingest once, match all tenants).
 */
export async function listActiveTermsWithSubscribers(args: { db: D1Database }): Promise<
  Array<{ normalizedTerm: string; subscribers: Array<{ orgId: string; keywordId: string }> }>
> {
  const { results } = await args.db
    .prepare('SELECT normalized_term, org_id, id FROM keywords WHERE muted = 0 ORDER BY normalized_term')
    .all<{ normalized_term: string; org_id: string; id: string }>();

  const byTerm = new Map<string, Array<{ orgId: string; keywordId: string }>>();
  for (const row of results) {
    const subscriber = { orgId: row.org_id, keywordId: row.id };
    const existing = byTerm.get(row.normalized_term);
    if (existing) {
      existing.push(subscriber);
    } else {
      byTerm.set(row.normalized_term, [subscriber]);
    }
  }
  return [...byTerm.entries()].map(([normalizedTerm, subscribers]) => ({ normalizedTerm, subscribers }));
}
