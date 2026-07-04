import { describe, expect, it } from 'vitest';
import { buildMatcher, type TermEntry } from '@mentions/core/match';
import { classifyJobSchema } from '@mentions/core/pipeline';
import type { RawItem } from '@mentions/core/schemas';
import { processRawItems, type MatcherDb, type MatchPayload } from '../src/process';

interface FakeStatement {
  sql: string;
  params: unknown[];
}

/** In-memory stand-in for the two D1 tables the matcher touches, enforcing
 *  the same UNIQUE constraints so INSERT OR IGNORE semantics are faithful. */
class FakeDb implements MatcherDb<FakeStatement> {
  readonly mentionsByKey = new Map<string, string>(); // source/externalId -> mention id
  readonly matchKeys = new Set<string>(); // orgId|mentionId|keywordId
  readonly statements: FakeStatement[] = [];
  batchCalls = 0;

  prepare(query: string): { bind(...values: unknown[]): FakeStatement } {
    return { bind: (...values: unknown[]) => ({ sql: query, params: values }) };
  }

  async batch(
    statements: FakeStatement[],
  ): Promise<Array<{ results: unknown[]; meta: { changes: number } }>> {
    this.batchCalls += 1;
    this.statements.push(...statements);
    return statements.map((statement) => this.run(statement));
  }

  private run(statement: FakeStatement): { results: unknown[]; meta: { changes: number } } {
    const { sql, params } = statement;
    if (sql.startsWith('INSERT OR IGNORE INTO mentions ')) {
      const [id, source, externalId] = params;
      const key = `${String(source)}/${String(externalId)}`;
      if (this.mentionsByKey.has(key)) return { results: [], meta: { changes: 0 } };
      this.mentionsByKey.set(key, String(id));
      return { results: [], meta: { changes: 1 } };
    }
    if (sql.startsWith('SELECT id FROM mentions')) {
      const [source, externalId] = params;
      const id = this.mentionsByKey.get(`${String(source)}/${String(externalId)}`);
      return { results: id === undefined ? [] : [{ id }], meta: { changes: 0 } };
    }
    if (sql.startsWith('INSERT OR IGNORE INTO mention_matches ')) {
      const [, orgId, mentionId, keywordId] = params;
      const key = `${String(orgId)}|${String(mentionId)}|${String(keywordId)}`;
      if (this.matchKeys.has(key)) return { results: [], meta: { changes: 0 } };
      this.matchKeys.add(key);
      return { results: [], meta: { changes: 1 } };
    }
    throw new Error(`FakeDb: unexpected sql: ${sql}`);
  }
}

const makeItem = (overrides: Partial<RawItem> = {}): RawItem => ({
  source: 'bluesky',
  externalId: 'did:plc:author1/rkey1',
  url: 'https://bsky.app/profile/did:plc:author1/post/rkey1',
  text: 'I just switched to Acme and love it',
  publishedAt: 1_750_000_000_000,
  ...overrides,
});

const twoOrgEntries: Array<TermEntry<MatchPayload>> = [
  { normalizedTerm: 'acme', payload: { orgId: 'org_1', keywordId: 'kw_1' } },
  { normalizedTerm: 'acme', payload: { orgId: 'org_2', keywordId: 'kw_2' } },
  { normalizedTerm: 'zernio', payload: { orgId: 'org_1', keywordId: 'kw_3' } },
];

describe('processRawItems', () => {
  it('skips non-matching items without touching the db', async () => {
    const db = new FakeDb();
    const result = await processRawItems({
      items: [makeItem({ text: 'nothing interesting here at all' })],
      match: buildMatcher(twoOrgEntries),
      db,
    });
    expect(result).toEqual({ classifyJobs: [], matchedItems: 0 });
    expect(db.batchCalls).toBe(0);
  });

  it('inserts the mention once and emits one classify job per subscriber', async () => {
    const db = new FakeDb();
    const { classifyJobs, matchedItems } = await processRawItems({
      items: [makeItem()],
      match: buildMatcher(twoOrgEntries),
      db,
    });

    expect(matchedItems).toBe(1);
    expect(db.mentionsByKey.size).toBe(1);
    expect(db.matchKeys.size).toBe(2);
    expect(classifyJobs).toHaveLength(2);
    expect(classifyJobs.map((job) => job.orgId).sort()).toEqual(['org_1', 'org_2']);
    for (const job of classifyJobs) {
      expect(job.mentionMatchId).toMatch(/^mm_/);
      expect(classifyJobSchema.safeParse(job).success).toBe(true);
    }
  });

  it('is idempotent: a redelivered batch produces zero new matches or jobs', async () => {
    const db = new FakeDb();
    const args = { items: [makeItem()], match: buildMatcher(twoOrgEntries), db };

    const first = await processRawItems(args);
    expect(first.classifyJobs).toHaveLength(2);

    const redelivery = await processRawItems(args);
    expect(redelivery.classifyJobs).toHaveLength(0); // changes = 0 on every insert
    expect(redelivery.matchedItems).toBe(1); // it still matched, just nothing new
    expect(db.mentionsByKey.size).toBe(1);
    expect(db.matchKeys.size).toBe(2);
  });

  it('emits jobs only for the subset of matches actually inserted', async () => {
    const db = new FakeDb();
    const item = makeItem();

    // First pass: only org_1 subscribes.
    await processRawItems({
      items: [item],
      match: buildMatcher([twoOrgEntries[0]!]),
      db,
    });

    // org_2 subscribes later; same item redelivered.
    const second = await processRawItems({
      items: [item],
      match: buildMatcher(twoOrgEntries),
      db,
    });
    expect(second.classifyJobs).toHaveLength(1);
    expect(second.classifyJobs[0]?.orgId).toBe('org_2');
  });

  it('truncates stored mention text to 8192 chars', async () => {
    const db = new FakeDb();
    await processRawItems({
      items: [makeItem({ text: `acme ${'x'.repeat(10_000)}` })],
      match: buildMatcher(twoOrgEntries),
      db,
    });
    const insert = db.statements.find((s) => s.sql.startsWith('INSERT OR IGNORE INTO mentions '));
    expect(insert).toBeDefined();
    expect(String(insert?.params[6]).length).toBe(8192);
  });

  it('matches case-insensitively with word boundaries (via core matcher)', async () => {
    const db = new FakeDb();
    const entries: Array<TermEntry<MatchPayload>> = [
      { normalizedTerm: 'late', payload: { orgId: 'org_9', keywordId: 'kw_9' } },
    ];
    const { classifyJobs } = await processRawItems({
      items: [
        makeItem({ externalId: 'did:plc:a/1', text: 'please translate this' }), // substring, no match
        makeItem({ externalId: 'did:plc:a/2', text: 'Shipped LATE again!' }), // word match
      ],
      match: buildMatcher(entries),
      db,
    });
    expect(classifyJobs).toHaveLength(1);
    expect(classifyJobs[0]?.orgId).toBe('org_9');
    expect(db.mentionsByKey.size).toBe(1); // only the matching item was persisted
  });
});
