/**
 * Bring-your-own source credentials (today: x bearer tokens). Stored per
 * (org, source); ingest resolves a term's auth as platform secret first,
 * then the oldest-configured token among orgs actively tracking that term.
 * Fetched data stays global and deduped regardless of whose token paid for
 * the poll (invariant: ingest once, match all tenants).
 */
import { asc, and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { keywords, orgSourceTokens } from '../db/schema';
import { normalizeTerm } from '../match';
import type { Source } from '../schemas';

/** Sources that accept a bring-your-own token. */
export const BYO_TOKEN_SOURCES: readonly Source[] = ['x'];

export async function setSourceToken(args: {
  db: D1Database;
  orgId: string;
  source: Source;
  token: string;
}): Promise<void> {
  const { db, orgId, source, token } = args;
  await getDb(db)
    .insert(orgSourceTokens)
    .values({ orgId, source, token, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: [orgSourceTokens.orgId, orgSourceTokens.source],
      set: { token },
    });
}

export async function deleteSourceToken(args: {
  db: D1Database;
  orgId: string;
  source: Source;
}): Promise<boolean> {
  const result = await getDb(args.db)
    .delete(orgSourceTokens)
    .where(and(eq(orgSourceTokens.orgId, args.orgId), eq(orgSourceTokens.source, args.source)));
  return (result.meta.changes ?? 0) > 0;
}

export async function hasSourceToken(args: {
  db: D1Database;
  orgId: string;
  source: Source;
}): Promise<boolean> {
  const row = await getDb(args.db)
    .select({ orgId: orgSourceTokens.orgId })
    .from(orgSourceTokens)
    .where(and(eq(orgSourceTokens.orgId, args.orgId), eq(orgSourceTokens.source, args.source)))
    .get();
  return row !== undefined;
}

/** The token a poll for this term may use when no platform secret exists:
 *  oldest-configured among orgs actively tracking the term, so resolution is
 *  deterministic and a keyword mute/delete drops eligibility naturally. */
export async function resolveTermToken(args: {
  db: D1Database;
  source: Source;
  term: string;
}): Promise<string | null> {
  const row = await getDb(args.db)
    .select({ token: orgSourceTokens.token })
    .from(orgSourceTokens)
    .innerJoin(keywords, eq(keywords.orgId, orgSourceTokens.orgId))
    .where(
      and(
        eq(orgSourceTokens.source, args.source),
        eq(keywords.normalizedTerm, normalizeTerm(args.term)),
        eq(keywords.muted, 0),
      ),
    )
    .orderBy(asc(orgSourceTokens.createdAt))
    .limit(1)
    .get();
  return row?.token ?? null;
}
