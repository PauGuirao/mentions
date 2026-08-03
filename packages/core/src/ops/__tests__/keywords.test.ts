/**
 * Keyword op tests against a REAL SQLite database running the actual
 * migrations (see d1-sqlite.ts), so they assert behavior — inserted rows,
 * enforced limits, FK-safe deletes — rather than SQL strings.
 */
import { describe, expect, it } from 'vitest';
import {
  DuplicateKeywordError,
  KeywordLimitError,
  createKeyword,
  deleteKeyword,
  listActiveTermsWithSubscribers,
  listKeywords,
  setKeywordMuted,
} from '../keywords';
import { createTestD1, seedOrg } from './d1-sqlite';

async function setup(): Promise<D1Database> {
  const db = createTestD1();
  await seedOrg(db, 'org_1');
  return db;
}

async function seedMentionWithMatch(
  db: D1Database,
  args: { mentionId: string; matchId: string; orgId: string; keywordId: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO mentions (id, source, external_id, url, text, published_at, created_at)
       VALUES (?1, 'hackernews', ?1, 'https://x/1', 'text', 1, 1)`,
    )
    .bind(args.mentionId)
    .run();
  await db
    .prepare(
      `INSERT INTO mention_matches (id, org_id, mention_id, keyword_id, created_at)
       VALUES (?1, ?2, ?3, ?4, 1)`,
    )
    .bind(args.matchId, args.orgId, args.mentionId, args.keywordId)
    .run();
}

describe('createKeyword', () => {
  it('stores the normalized term alongside the display term', async () => {
    const db = await setup();
    const keyword = await createKeyword({ db, orgId: 'org_1', term: '  Acme   Corp ', kind: 'brand' });

    expect(keyword.id).toMatch(/^kw_/);
    expect(keyword.muted).toBe(false);
    const row = await db
      .prepare('SELECT term, normalized_term FROM keywords WHERE id = ?1')
      .bind(keyword.id)
      .first<{ term: string; normalized_term: string }>();
    expect(row).toEqual({ term: '  Acme   Corp ', normalized_term: 'acme corp' });
  });

  it('rejects a duplicate normalized term for the same org', async () => {
    const db = await setup();
    await createKeyword({ db, orgId: 'org_1', term: 'Acme', kind: 'brand' });
    await expect(
      createKeyword({ db, orgId: 'org_1', term: '  ACME ', kind: 'topic' }),
    ).rejects.toBeInstanceOf(DuplicateKeywordError);
  });

  it('enforces the free-plan cap of 2 active keywords', async () => {
    const db = await setup();
    await createKeyword({ db, orgId: 'org_1', term: 'one', kind: 'brand' });
    await createKeyword({ db, orgId: 'org_1', term: 'two', kind: 'brand' });
    await expect(
      createKeyword({ db, orgId: 'org_1', term: 'three', kind: 'brand' }),
    ).rejects.toBeInstanceOf(KeywordLimitError);
  });

  it('does not count muted keywords toward the cap', async () => {
    const db = await setup();
    await createKeyword({ db, orgId: 'org_1', term: 'one', kind: 'brand' });
    const second = await createKeyword({ db, orgId: 'org_1', term: 'two', kind: 'brand' });
    await setKeywordMuted({ db, orgId: 'org_1', keywordId: second.id, muted: true });
    await expect(
      createKeyword({ db, orgId: 'org_1', term: 'three', kind: 'brand' }),
    ).resolves.toMatchObject({ term: 'three' });
  });
});

describe('listKeywords', () => {
  it('returns org keywords newest first with muted as a boolean', async () => {
    const db = await setup();
    await db
      .prepare(
        `INSERT INTO keywords (id, org_id, term, normalized_term, kind, muted, created_at) VALUES
         ('kw_old', 'org_1', 'old', 'old', 'brand', 0, 100),
         ('kw_new', 'org_1', 'new', 'new', 'topic', 1, 200)`,
      )
      .run();
    const list = await listKeywords({ db, orgId: 'org_1' });
    expect(list.map((k) => k.id)).toEqual(['kw_new', 'kw_old']);
    expect(list[0]).toMatchObject({ kind: 'topic', muted: true });
    expect(list[1]).toMatchObject({ kind: 'brand', muted: false });
  });
});

describe('deleteKeyword', () => {
  it('deletes matches and orphaned mentions but keeps shared mentions', async () => {
    const db = await setup();
    await seedOrg(db, 'org_2');
    const mine = await createKeyword({ db, orgId: 'org_1', term: 'mine', kind: 'brand' });
    const theirs = await createKeyword({ db, orgId: 'org_2', term: 'theirs', kind: 'brand' });

    // m_orphan is matched only by the keyword being deleted; m_shared is also
    // matched by another org's keyword and must survive.
    await seedMentionWithMatch(db, { mentionId: 'm_orphan', matchId: 'mm_1', orgId: 'org_1', keywordId: mine.id });
    await seedMentionWithMatch(db, { mentionId: 'm_shared', matchId: 'mm_2', orgId: 'org_1', keywordId: mine.id });
    await seedMentionWithMatch(db, { mentionId: 'm_shared', matchId: 'mm_3', orgId: 'org_2', keywordId: theirs.id });

    expect(await deleteKeyword({ db, orgId: 'org_1', keywordId: mine.id })).toBe(true);

    const remainingMentions = await db.prepare('SELECT id FROM mentions ORDER BY id').all<{ id: string }>();
    expect(remainingMentions.results.map((r) => r.id)).toEqual(['m_shared']);
    const remainingMatches = await db.prepare('SELECT id FROM mention_matches').all<{ id: string }>();
    expect(remainingMatches.results.map((r) => r.id)).toEqual(['mm_3']);
  });

  it('returns false when the keyword does not exist for the org', async () => {
    const db = await setup();
    expect(await deleteKeyword({ db, orgId: 'org_1', keywordId: 'kw_missing' })).toBe(false);
  });
});

describe('setKeywordMuted', () => {
  it('mutes and idempotently unmutes', async () => {
    const db = await setup();
    const keyword = await createKeyword({ db, orgId: 'org_1', term: 'one', kind: 'brand' });
    expect(await setKeywordMuted({ db, orgId: 'org_1', keywordId: keyword.id, muted: true })).toBe(true);
    expect(await setKeywordMuted({ db, orgId: 'org_1', keywordId: keyword.id, muted: false })).toBe(true);
    // Already active: still true, no limit error.
    expect(await setKeywordMuted({ db, orgId: 'org_1', keywordId: keyword.id, muted: false })).toBe(true);
  });

  it('blocks unmuting past the capacity limit', async () => {
    const db = await setup();
    const first = await createKeyword({ db, orgId: 'org_1', term: 'one', kind: 'brand' });
    await createKeyword({ db, orgId: 'org_1', term: 'two', kind: 'brand' });
    await setKeywordMuted({ db, orgId: 'org_1', keywordId: first.id, muted: true });
    await createKeyword({ db, orgId: 'org_1', term: 'three', kind: 'brand' });

    await expect(
      setKeywordMuted({ db, orgId: 'org_1', keywordId: first.id, muted: false }),
    ).rejects.toBeInstanceOf(KeywordLimitError);
  });

  it('returns false for a keyword that does not exist', async () => {
    const db = await setup();
    expect(await setKeywordMuted({ db, orgId: 'org_1', keywordId: 'kw_nope', muted: false })).toBe(false);
  });
});

describe('listActiveTermsWithSubscribers', () => {
  it('groups unmuted keywords across orgs by normalized term', async () => {
    const db = await setup();
    await seedOrg(db, 'org_2');
    const a = await createKeyword({ db, orgId: 'org_1', term: 'Acme', kind: 'brand' });
    const b = await createKeyword({ db, orgId: 'org_2', term: ' acme ', kind: 'competitor' });
    const muted = await createKeyword({ db, orgId: 'org_2', term: 'quiet', kind: 'topic' });
    await setKeywordMuted({ db, orgId: 'org_2', keywordId: muted.id, muted: true });

    const terms = await listActiveTermsWithSubscribers({ db });
    expect(terms).toEqual([
      {
        normalizedTerm: 'acme',
        subscribers: [
          { orgId: 'org_1', keywordId: a.id },
          { orgId: 'org_2', keywordId: b.id },
        ],
      },
    ]);
  });
});
