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
import { createDbStub, type RecordedQuery } from './stubs';

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

const makeRow = (n: number) => ({
  match_id: `mm_${n}`,
  source: 'github',
  url: `https://github.com/x/${n}`,
  author: 'octocat',
  author_url: null,
  text: `mention ${n}`,
  published_at: 1000 + n,
  keyword_id: 'kw_1',
  keyword_term: 'acme',
  state: 'classified',
  relevance: 90,
  sentiment: 'positive',
  intents: '["question","buy_intent"]',
  ai_note: null,
  match_created_at: 2000 - n,
});

describe('searchMentions', () => {
  it('maps joined rows into the Mention shape (intents JSON parsed)', async () => {
    const { db } = createDbStub(() => ({ results: [makeRow(1)] }));
    const query = searchMentionsQuerySchema.parse({});

    const { mentions, nextCursor } = await searchMentions({ db, orgId: 'org_1', query });
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

  it('treats null/malformed intents as empty', async () => {
    const { db } = createDbStub(() => ({
      results: [
        { ...makeRow(1), intents: null },
        { ...makeRow(2), intents: 'not-json' },
      ],
    }));
    const { mentions } = await searchMentions({ db, orgId: 'org_1', query: searchMentionsQuerySchema.parse({}) });
    expect(mentions.map((m) => m.intents)).toEqual([[], []]);
  });

  it('fetches limit+1 and emits a nextCursor pointing at the last returned row', async () => {
    const { db, queries } = createDbStub(() => ({ results: [makeRow(1), makeRow(2), makeRow(3)] }));
    const query = searchMentionsQuerySchema.parse({ limit: '2' });

    const { mentions, nextCursor } = await searchMentions({ db, orgId: 'org_1', query });
    expect(mentions).toHaveLength(2);
    expect(queries[0]!.params.at(-1)).toBe(3); // limit + 1
    expect(nextCursor).not.toBeNull();
    expect(decodeMentionsCursor(nextCursor!)).toEqual({ createdAt: 1998, id: 'mm_2' });
  });

  it('applies the keyset clause when a cursor is passed', async () => {
    const { db, queries } = createDbStub(() => ({ results: [] }));
    const cursor = encodeMentionsCursor({ createdAt: 1998, id: 'mm_2' });
    await searchMentions({ db, orgId: 'org_1', query: searchMentionsQuerySchema.parse({ cursor }) });

    const q = queries[0]!;
    expect(q.sql).toContain('(mm.created_at < ? OR (mm.created_at = ? AND mm.id < ?))');
    expect(q.params).toContain(1998);
    expect(q.params).toContain('mm_2');
  });

  it('throws InvalidCursorError on a garbage cursor', async () => {
    const { db } = createDbStub();
    await expect(
      searchMentions({ db, orgId: 'org_1', query: searchMentionsQuerySchema.parse({ cursor: 'garbage!' }) }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('builds WHERE clauses for every filter and escapes LIKE wildcards in q', async () => {
    const { db, queries } = createDbStub(() => ({ results: [] }));
    const query = searchMentionsQuerySchema.parse({
      keywordId: 'kw_1',
      source: 'github',
      state: 'classified',
      minRelevance: '80',
      sentiment: 'positive',
      intent: 'buy_intent',
      q: '50%_off',
      since: '100',
      until: '200',
    });
    await searchMentions({ db, orgId: 'org_1', query });

    const q: RecordedQuery = queries[0]!;
    for (const clause of [
      'mm.org_id = ?',
      'mm.keyword_id = ?',
      'm.source = ?',
      'mm.state = ?',
      'mm.relevance >= ?',
      'mm.sentiment = ?',
      'mm.intents LIKE ?',
      'm.text LIKE ?',
      'm.published_at >= ?',
      'm.published_at <= ?',
    ]) {
      expect(q.sql).toContain(clause);
    }
    // Underscore is a LIKE wildcard, so it is escaped for a literal match.
    expect(q.params).toContain('%"buy\\_intent"%');
    expect(q.params).toContain('%50\\%\\_off%');
    expect(q.params).toContain(80);
    expect(q.params).toContain(100);
    expect(q.params).toContain(200);
  });
});

describe('getMention', () => {
  it('returns null when the match does not exist for the org', async () => {
    const { db, queries } = createDbStub(() => ({ first: null }));
    const mention = await getMention({ db, orgId: 'org_1', mentionMatchId: 'mm_missing' });
    expect(mention).toBeNull();
    expect(queries[0]!.params).toEqual(['mm_missing', 'org_1']);
  });
});

describe('setMentionState', () => {
  it('scopes the update to the org and reports whether a row changed', async () => {
    const { db, queries } = createDbStub(() => ({ changes: 1 }));
    const updated = await setMentionState({ db, orgId: 'org_1', mentionMatchId: 'mm_1', state: 'done' });
    expect(updated).toBe(true);
    expect(queries[0]!.sql).toContain('WHERE id = ? AND org_id = ?');
    expect(queries[0]!.params).toEqual(['done', 'mm_1', 'org_1']);
  });

  it('returns false when nothing matched', async () => {
    const { db } = createDbStub(() => ({ changes: 0 }));
    const updated = await setMentionState({ db, orgId: 'org_1', mentionMatchId: 'mm_x', state: 'ignored' });
    expect(updated).toBe(false);
  });
});
