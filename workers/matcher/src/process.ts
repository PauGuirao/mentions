/**
 * Match RawItems against the term registry and persist hits.
 *
 * Idempotency: mentions are UNIQUE(source, external_id) and matches are
 * UNIQUE(org_id, mention_id, keyword_id); both inserts are INSERT OR IGNORE,
 * and a classify job is emitted only for statements that actually wrote a row
 * (meta.changes > 0). A redelivered queue batch therefore produces zero
 * duplicate matches and zero duplicate classify jobs.
 *
 * Known tradeoff: if the worker dies after the match inserts commit but
 * before the classify jobs are sent, the redelivery sees changes = 0 and does
 * not resend — those rows sit in state 'matched' until a reconciliation sweep
 * (future work). We prefer that over duplicate classification.
 */
import { newId } from '@mentions/core/ids';
import type { ClassifyJob } from '@mentions/core/pipeline';
import type { RawItem } from '@mentions/core/schemas';

/** Matcher payload: one subscriber (org keyword) of a normalized term. */
export interface MatchPayload {
  orgId: string;
  keywordId: string;
}

/** Structural slice of D1Database used here — D1Database satisfies
 *  MatcherDb<D1PreparedStatement>, and tests inject a fake without casts. */
export interface MatcherDb<S> {
  prepare(query: string): { bind(...values: unknown[]): S };
  batch(statements: S[]): Promise<Array<{ results: unknown[]; meta: { changes: number } }>>;
}

/** mentions.text cap (see migrations/0001_init.sql — truncated to 8KB at ingest). */
const MAX_TEXT_LENGTH = 8192;

const SQL_INSERT_MENTION =
  'INSERT OR IGNORE INTO mentions (id, source, external_id, url, author, author_url, text, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const SQL_SELECT_MENTION_ID = 'SELECT id FROM mentions WHERE source = ? AND external_id = ?';
const SQL_INSERT_MATCH =
  "INSERT OR IGNORE INTO mention_matches (id, org_id, mention_id, keyword_id, state, created_at) VALUES (?, ?, ?, ?, 'matched', ?)";

const readId = (row: unknown): string | null => {
  if (row !== null && typeof row === 'object' && 'id' in row) {
    const id = (row as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
};

export async function processRawItems<S>(args: {
  items: ReadonlyArray<RawItem>;
  match: (text: string) => MatchPayload[];
  db: MatcherDb<S>;
  now?: number;
}): Promise<{ classifyJobs: ClassifyJob[]; matchedItems: number }> {
  const { items, match, db } = args;
  const now = args.now ?? Date.now();

  // Hot path: virtually every firehose item matches nothing — one lowercase
  // + one matcher pass, no D1, no allocations beyond the matcher's hit array.
  const hitItems: Array<{ item: RawItem; hits: MatchPayload[] }> = [];
  for (const item of items) {
    const hits = match(item.text.toLowerCase());
    if (hits.length > 0) hitItems.push({ item, hits });
  }
  if (hitItems.length === 0) return { classifyJobs: [], matchedItems: 0 };

  // Phase 1: ensure the global mention row exists and read back its canonical
  // id in the same round trip (the INSERT is a no-op for redeliveries and
  // cross-tenant repeats; the SELECT then returns the winning row's id).
  const phase1: S[] = [];
  for (const { item } of hitItems) {
    phase1.push(
      db
        .prepare(SQL_INSERT_MENTION)
        .bind(
          newId('men'),
          item.source,
          item.externalId,
          item.url,
          item.author ?? null,
          item.authorUrl ?? null,
          item.text.slice(0, MAX_TEXT_LENGTH),
          item.publishedAt,
          now,
        ),
    );
    phase1.push(db.prepare(SQL_SELECT_MENTION_ID).bind(item.source, item.externalId));
  }
  const phase1Results = await db.batch(phase1);

  const mentionIds: string[] = [];
  for (let i = 0; i < hitItems.length; i += 1) {
    const id = readId(phase1Results[i * 2 + 1]?.results[0]);
    if (id === null) {
      throw new Error(`mention row missing after insert: ${hitItems[i]?.item.externalId ?? '?'}`);
    }
    mentionIds.push(id);
  }

  // Phase 2: tenant-scoped matches. mm ids are pre-generated so each classify
  // job is tied to exactly the statement that inserted its row.
  const phase2: S[] = [];
  const pendingJobs: ClassifyJob[] = [];
  for (let i = 0; i < hitItems.length; i += 1) {
    const mentionId = mentionIds[i];
    const entry = hitItems[i];
    if (mentionId === undefined || entry === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
    for (const hit of entry.hits) {
      const matchId = newId('mm');
      phase2.push(db.prepare(SQL_INSERT_MATCH).bind(matchId, hit.orgId, mentionId, hit.keywordId, now));
      pendingJobs.push({ mentionMatchId: matchId, orgId: hit.orgId });
    }
  }
  const phase2Results = await db.batch(phase2);

  // changes > 0 ⇔ this delivery inserted the row ⇒ we own sending its job.
  const classifyJobs = pendingJobs.filter((_, idx) => (phase2Results[idx]?.meta.changes ?? 0) > 0);
  return { classifyJobs, matchedItems: hitItems.length };
}
