/**
 * Keyword operations. Pure functions over D1 (via drizzle): the REST API,
 * the MCP server, the matcher and the scheduler all call through here
 * (invariant: no product logic in worker handlers).
 *
 * The two capacity-gated writes stay RAW SQL on purpose: their correctness
 * depends on the count guard riding inside the same statement as the write,
 * and that shape should be reviewed as SQL, not reconstructed from builder
 * calls. Everything routine uses the query builder.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { keywords, mentionMatches, mentions } from '../db/schema';
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

/** Drizzle wraps driver errors (DrizzleQueryError) with the SQLite message on
 *  the cause chain, so the constraint check must walk it. */
function isUniqueViolation(err: unknown): boolean {
  for (let depth = 0; err instanceof Error && depth < 5; depth++) {
    if (/UNIQUE constraint failed/i.test(err.message)) return true;
    err = err.cause;
  }
  return false;
}

export async function createKeyword(args: {
  db: D1Database;
  orgId: string;
  term: string;
  kind: 'brand' | 'competitor' | 'topic';
}): Promise<Keyword> {
  const { db, orgId, term, kind } = args;
  const orm = getDb(db);
  const limit = await getKeywordLimit({ db, orgId });
  const id = newId('kw');
  const createdAt = Date.now();
  try {
    // Capacity check and insert are ONE statement: a separate read-then-write
    // lets two concurrent creates both pass the gate. changes = 0 here can
    // only mean the WHERE guard failed, i.e. the org is at its limit.
    // null limit (subscribed, pay per keyword) binds an unreachable cap.
    const result = await orm.run(sql`
      INSERT INTO keywords (id, org_id, term, normalized_term, kind, muted, created_at)
      SELECT ${id}, ${orgId}, ${term}, ${normalizeTerm(term)}, ${kind}, 0, ${createdAt}
      WHERE (SELECT COUNT(*) FROM keywords WHERE org_id = ${orgId} AND muted = 0) < ${limit ?? Number.MAX_SAFE_INTEGER}`);
    if ((result.meta.changes ?? 0) === 0) {
      throw new KeywordLimitError(limit ?? Number.MAX_SAFE_INTEGER);
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DuplicateKeywordError(term);
    }
    throw err;
  }
  await syncKeywordUsage({ db, orgId, nowMs: createdAt });
  return { id, term, kind, muted: false, createdAt };
}

export async function listKeywords(args: { db: D1Database; orgId: string }): Promise<Keyword[]> {
  const rows = await getDb(args.db)
    .select({
      id: keywords.id,
      term: keywords.term,
      kind: keywords.kind,
      muted: keywords.muted,
      createdAt: keywords.createdAt,
    })
    .from(keywords)
    .where(eq(keywords.orgId, args.orgId))
    .orderBy(desc(keywords.createdAt));
  return rows.map((row) => ({ ...row, muted: row.muted === 1 }));
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
  const orm = getDb(db);

  // A mention is global and reachable only through mention_matches. Once this
  // keyword's matches are gone, any mention matched by nothing else is
  // orphaned in the mentions table forever. Collect those ids first (while the
  // matches still exist to read); a mention still matched by another
  // keyword/org is excluded and left in place.
  const orphans = await orm.all<{ id: string }>(sql`
    SELECT mm.mention_id AS id FROM mention_matches mm
    WHERE mm.org_id = ${orgId} AND mm.keyword_id = ${keywordId}
      AND NOT EXISTS (
        SELECT 1 FROM mention_matches other
        WHERE other.mention_id = mm.mention_id
          AND NOT (other.org_id = ${orgId} AND other.keyword_id = ${keywordId})
      )`);

  // mention_matches carries plain FKs on both keyword_id and mention_id (no ON
  // DELETE CASCADE), so within the batch the matches must be deleted before
  // both the keyword and the orphaned mentions, or D1 rejects the parent
  // delete. If a concurrent match lands on an orphan between the read above and
  // this batch, the FK makes the mention delete fail and rolls the batch back
  // (fail closed, no dangling row) — a retry then sees the mention as non-orphan.
  const matchesDelete = orm
    .delete(mentionMatches)
    .where(and(eq(mentionMatches.orgId, orgId), eq(mentionMatches.keywordId, keywordId)));
  const keywordDelete = orm
    .delete(keywords)
    .where(and(eq(keywords.id, keywordId), eq(keywords.orgId, orgId)));
  const orphanDeletes = [];
  for (let i = 0; i < orphans.length; i += ORPHAN_DELETE_CHUNK) {
    const ids = orphans.slice(i, i + ORPHAN_DELETE_CHUNK).map((row) => row.id);
    orphanDeletes.push(orm.delete(mentions).where(inArray(mentions.id, ids)));
  }

  const results = await orm.batch([matchesDelete, keywordDelete, ...orphanDeletes]);
  // results[1] is the keyword delete; its change count is the existence signal.
  const keywordResult = results[1] as { meta: { changes?: number } };
  return (keywordResult.meta.changes ?? 0) > 0;
}

export async function setKeywordMuted(args: {
  db: D1Database;
  orgId: string;
  keywordId: string;
  muted: boolean;
}): Promise<boolean> {
  const { db, orgId, keywordId } = args;
  const orm = getDb(db);
  if (args.muted) {
    const result = await orm
      .update(keywords)
      .set({ muted: 1 })
      .where(and(eq(keywords.id, keywordId), eq(keywords.orgId, orgId)));
    return (result.meta.changes ?? 0) > 0;
  }

  // Unmuting re-activates a keyword, so the capacity gate rides in the same
  // statement as the write (same race rationale as createKeyword). changes=0
  // is ambiguous (missing, already unmuted, or at capacity), so it is
  // disambiguated with one follow-up read.
  const limit = await getKeywordLimit({ db, orgId });
  const result = await orm.run(sql`
    UPDATE keywords SET muted = 0
    WHERE id = ${keywordId} AND org_id = ${orgId} AND muted = 1
      AND (SELECT COUNT(*) FROM keywords WHERE org_id = ${orgId} AND muted = 0) < ${limit ?? Number.MAX_SAFE_INTEGER}`);
  if ((result.meta.changes ?? 0) > 0) {
    await syncKeywordUsage({ db, orgId });
    return true;
  }

  const row = await orm
    .select({ muted: keywords.muted })
    .from(keywords)
    .where(and(eq(keywords.id, keywordId), eq(keywords.orgId, orgId)))
    .get();
  if (!row) return false;
  if (row.muted === 0) return true; // already active: idempotent success
  throw new KeywordLimitError(limit ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Every unmuted keyword across ALL orgs, grouped by normalized term. The
 * scheduler polls search-API sources once per entry; the matcher fans a hit
 * back out to every subscriber (invariant: ingest once, match all tenants).
 */
export async function listActiveTermsWithSubscribers(args: { db: D1Database }): Promise<
  Array<{ normalizedTerm: string; subscribers: Array<{ orgId: string; keywordId: string }> }>
> {
  const rows = await getDb(args.db)
    .select({ normalizedTerm: keywords.normalizedTerm, orgId: keywords.orgId, id: keywords.id })
    .from(keywords)
    .where(eq(keywords.muted, 0))
    .orderBy(asc(keywords.normalizedTerm));

  const byTerm = new Map<string, Array<{ orgId: string; keywordId: string }>>();
  for (const row of rows) {
    const subscriber = { orgId: row.orgId, keywordId: row.id };
    const existing = byTerm.get(row.normalizedTerm);
    if (existing) {
      existing.push(subscriber);
    } else {
      byTerm.set(row.normalizedTerm, [subscriber]);
    }
  }
  return [...byTerm.entries()].map(([normalizedTerm, subscribers]) => ({
    normalizedTerm,
    subscribers,
  }));
}
