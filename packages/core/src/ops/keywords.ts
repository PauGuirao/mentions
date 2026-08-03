/**
 * Keyword operations. Pure functions over D1: the REST API, the MCP server,
 * the matcher and the scheduler all call through here (invariant: no product
 * logic in worker handlers).
 */
import { newId } from '../ids';
import { normalizeTerm } from '../match';
import type { Keyword } from '../schemas';
import { KeywordLimitError, getKeywordLimit, syncKeywordUsage } from './billing';

export { KeywordLimitError } from './billing';

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
  const limit = await getKeywordLimit({ db, orgId });
  const id = newId('kw');
  const createdAt = Date.now();
  try {
    // Capacity check and insert are ONE statement: a separate read-then-write
    // lets two concurrent creates both pass the gate. changes = 0 here can
    // only mean the WHERE guard failed, i.e. the org is at its limit.
    const result = await db
      .prepare(
        `INSERT INTO keywords (id, org_id, term, normalized_term, kind, muted, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 0, ?6
         WHERE (SELECT COUNT(*) FROM keywords WHERE org_id = ?2 AND muted = 0) < ?7`,
      )
      .bind(id, orgId, term, normalizeTerm(term), kind, createdAt, limit)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      throw new KeywordLimitError(limit);
    }
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw new DuplicateKeywordError(term);
    }
    throw err;
  }
  await syncKeywordUsage({ db, orgId, nowMs: createdAt });
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
  const { db, orgId, keywordId } = args;
  if (args.muted) {
    const result = await db
      .prepare('UPDATE keywords SET muted = 1 WHERE id = ? AND org_id = ?')
      .bind(keywordId, orgId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  // Unmuting re-activates a keyword, so the capacity gate rides in the same
  // statement as the write (same race rationale as createKeyword). changes=0
  // is ambiguous (missing, already unmuted, or at capacity), so it is
  // disambiguated with one follow-up read.
  const limit = await getKeywordLimit({ db, orgId });
  const result = await db
    .prepare(
      `UPDATE keywords SET muted = 0
       WHERE id = ?1 AND org_id = ?2 AND muted = 1
         AND (SELECT COUNT(*) FROM keywords WHERE org_id = ?2 AND muted = 0) < ?3`,
    )
    .bind(keywordId, orgId, limit)
    .run();
  if ((result.meta.changes ?? 0) > 0) {
    await syncKeywordUsage({ db, orgId });
    return true;
  }

  const row = await db
    .prepare('SELECT muted FROM keywords WHERE id = ? AND org_id = ?')
    .bind(keywordId, orgId)
    .first<{ muted: number }>();
  if (!row) return false;
  if (row.muted === 0) return true; // already active: idempotent success
  throw new KeywordLimitError(limit);
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
