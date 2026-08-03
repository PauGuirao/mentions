import { describe, expect, it } from 'vitest';
import { searchMentionsQuerySchema } from '../../schemas';
import {
  InvalidCursorError,
  decodeMentionsCursor,
  encodeMentionsCursor,
  getMention,
  searchMentions,
  setMentionState,
} from '../mentions';
import { createTestD1, seedOrg } from './d1-sqlite';

describe('mentions cursor', () => {
  it('round-trips', () => {
    const cursor = { createdAt: 1751600000000, id: 'mm_abc123' };
    expect(decodeMentionsCursor(encodeMentionsCursor(cursor))).toEqual(cursor);
  });

  it('round-trips ids containing colons', () => {
    const cursor = { createdAt: 42, id: 'mm_we:ird' };
    expect(decodeMentionsCursor(encodeMentionsCursor(cursor))).toEqual(cursor);
  });

  it('rejects non-base64 input', () => {
    expect(decodeMentionsCursor('!!not-base64!!')).toBeNull();
  });

  it('rejects base64 that does not contain createdAt:id', () => {
    expect(decodeMentionsCursor(btoa('hello'))).toBeNull();
    expect(decodeMentionsCursor(btoa('NaN:mm_1'))).toBeNull();
    expect(decodeMentionsCursor(btoa('123:'))).toBeNull();
  });
});

interface SeedMatch {
  n: number;
  source?: string;
  state?: string;
  relevance?: number | null;
  sentiment?: string | null;
  intents?: string | null;
  text?: string;
}

/** One org, one keyword, N mention+match pairs. match mm_<n> has
 *  created_at = 2000 - n, so mm_1 is the newest. */
async function seedMentions(db: D1Database, matches: SeedMatch[]): Promise<void> {
  await seedOrg(db, 'org_1');
  await db
    .prepare(
      `INSERT INTO keywords (id, org_id, term, normalized_term, kind, muted, created_at)
       VALUES ('kw_1', 'org_1', 'acme', 'acme', 'brand', 0, 1)`,
    )
    .run();
  for (const m of matches) {
    await db
      .prepare(
        `INSERT INTO mentions (id, source, external_id, url, author, text, published_at, created_at)
         VALUES (?1, ?2, ?1, ?3, 'octocat', ?4, ?5, 1)`,
      )
      .bind(`m_${m.n}`, m.source ?? 'github', `https://github.com/x/${m.n}`, m.text ?? `mention ${m.n}`, 1000 + m.n)
      .run();
    await db
      .prepare(
        `INSERT INTO mention_matches (id, org_id, mention_id, keyword_id, state, relevance, sentiment, intents, created_at)
         VALUES (?1, ?2, ?3, 'kw_1', ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        `mm_${m.n}`,
        'org_1',
        `m_${m.n}`,
        m.state ?? 'classified',
        m.relevance === undefined ? 90 : m.relevance,
        m.sentiment === undefined ? 'positive' : m.sentiment,
        m.intents === undefined ? '["question","buy_intent"]' : m.intents,
        2000 - m.n,
      )
      .run();
  }
}

const parse = (q: Record<string, unknown>) => searchMentionsQuerySchema.parse(q);

describe('searchMentions', () => {
  it('maps joined rows into the Mention shape (intents JSON parsed)', async () => {
    const db = createTestD1();
    await seedMentions(db, [{ n: 1 }]);

    const { mentions, nextCursor } = await searchMentions({ db, orgId: 'org_1', query: parse({}) });
    expect(nextCursor).toBeNull();
    expect(mentions).toEqual([
      {
        id: 'mm_1',
        source: 'github',
        url: 'https://github.com/x/1',
        author: 'octocat',
        authorUrl: null,
        text: 'mention 1',
        publishedAt: 1001,
        keywordId: 'kw_1',
        keywordTerm: 'acme',
        state: 'classified',
        relevance: 90,
        sentiment: 'positive',
        intents: ['question', 'buy_intent'],
        aiNote: null,
        createdAt: 1999,
      },
    ]);
  });

  it('applies filters: source, state, minRelevance, sentiment, intent', async () => {
    const db = createTestD1();
    await seedMentions(db, [
      { n: 1, source: 'github', state: 'classified', relevance: 90, sentiment: 'positive' },
      { n: 2, source: 'reddit', state: 'classified', relevance: 40, sentiment: 'negative', intents: '["complaint"]' },
      { n: 3, source: 'github', state: 'ignored', relevance: 80, sentiment: 'neutral', intents: null },
    ]);
    const search = async (q: Record<string, unknown>) =>
      (await searchMentions({ db, orgId: 'org_1', query: parse(q) })).mentions.map((m) => m.id);

    await expect(search({ source: 'reddit' })).resolves.toEqual(['mm_2']);
    await expect(search({ state: 'ignored' })).resolves.toEqual(['mm_3']);
    await expect(search({ minRelevance: 80 })).resolves.toEqual(['mm_1', 'mm_3']);
    await expect(search({ sentiment: 'negative' })).resolves.toEqual(['mm_2']);
    await expect(search({ intent: 'complaint' })).resolves.toEqual(['mm_2']);
    await expect(search({ intent: 'question' })).resolves.toEqual(['mm_1']);
  });

  it('matches free text literally, escaping LIKE wildcards', async () => {
    const db = createTestD1();
    await seedMentions(db, [
      { n: 1, text: 'we got 100% uptime with acme' },
      { n: 2, text: 'acme is 100x better' },
    ]);
    const search = async (q: Record<string, unknown>) =>
      (await searchMentions({ db, orgId: 'org_1', query: parse(q) })).mentions.map((m) => m.id);

    // A literal "%" must not act as a wildcard.
    await expect(search({ q: '100%' })).resolves.toEqual(['mm_1']);
    await expect(search({ q: 'acme' })).resolves.toEqual(['mm_1', 'mm_2']);
  });

  it('paginates with a keyset cursor, newest first', async () => {
    const db = createTestD1();
    await seedMentions(db, [{ n: 1 }, { n: 2 }, { n: 3 }]);

    const first = await searchMentions({ db, orgId: 'org_1', query: parse({ limit: 2 }) });
    expect(first.mentions.map((m) => m.id)).toEqual(['mm_1', 'mm_2']);
    expect(first.nextCursor).not.toBeNull();

    const second = await searchMentions({
      db,
      orgId: 'org_1',
      query: parse({ limit: 2, cursor: first.nextCursor }),
    });
    expect(second.mentions.map((m) => m.id)).toEqual(['mm_3']);
    expect(second.nextCursor).toBeNull();
  });

  it('throws InvalidCursorError for a malformed cursor', async () => {
    const db = createTestD1();
    await seedMentions(db, [{ n: 1 }]);
    await expect(
      searchMentions({ db, orgId: 'org_1', query: parse({ cursor: '!!bad!!' }) }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('scopes to the org', async () => {
    const db = createTestD1();
    await seedMentions(db, [{ n: 1 }]);
    const { mentions } = await searchMentions({ db, orgId: 'org_other', query: parse({}) });
    expect(mentions).toEqual([]);
  });
});

describe('getMention', () => {
  it('returns one mention by match id, org-scoped', async () => {
    const db = createTestD1();
    await seedMentions(db, [{ n: 1 }]);
    const mention = await getMention({ db, orgId: 'org_1', mentionMatchId: 'mm_1' });
    expect(mention?.id).toBe('mm_1');
    await expect(getMention({ db, orgId: 'org_other', mentionMatchId: 'mm_1' })).resolves.toBeNull();
  });
});

describe('setMentionState', () => {
  it('updates the state and reports existence, org-scoped', async () => {
    const db = createTestD1();
    await seedMentions(db, [{ n: 1 }]);
    await expect(
      setMentionState({ db, orgId: 'org_1', mentionMatchId: 'mm_1', state: 'done' }),
    ).resolves.toBe(true);
    const mention = await getMention({ db, orgId: 'org_1', mentionMatchId: 'mm_1' });
    expect(mention?.state).toBe('done');
    await expect(
      setMentionState({ db, orgId: 'org_other', mentionMatchId: 'mm_1', state: 'ignored' }),
    ).resolves.toBe(false);
  });
});
