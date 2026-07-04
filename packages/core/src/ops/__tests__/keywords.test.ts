import { describe, expect, it } from 'vitest';
import {
  DuplicateKeywordError,
  createKeyword,
  deleteKeyword,
  listActiveTermsWithSubscribers,
  setKeywordMuted,
} from '../keywords';
import { createDbStub } from './stubs';

describe('createKeyword', () => {
  it('stores the normalized term alongside the display term', async () => {
    const { db, queries } = createDbStub();
    const keyword = await createKeyword({ db, orgId: 'org_1', term: '  Acme   Corp ', kind: 'brand' });

    expect(keyword.id).toMatch(/^kw_/);
    expect(keyword.term).toBe('  Acme   Corp ');
    expect(keyword.kind).toBe('brand');
    expect(keyword.muted).toBe(false);

    const [, orgId, term, normalizedTerm, kind] = queries[0]!.params;
    expect(orgId).toBe('org_1');
    expect(term).toBe('  Acme   Corp ');
    expect(normalizedTerm).toBe('acme corp');
    expect(kind).toBe('brand');
  });

  it('maps the UNIQUE(org_id, normalized_term) violation to DuplicateKeywordError', async () => {
    const { db } = createDbStub(() => ({
      error: new Error(
        'D1_ERROR: UNIQUE constraint failed: keywords.org_id, keywords.normalized_term: SQLITE_CONSTRAINT',
      ),
    }));
    await expect(createKeyword({ db, orgId: 'org_1', term: 'acme', kind: 'brand' })).rejects.toBeInstanceOf(
      DuplicateKeywordError,
    );
  });

  it('rethrows non-unique-constraint errors untouched', async () => {
    const { db } = createDbStub(() => ({ error: new Error('D1_ERROR: no such table: keywords') }));
    await expect(createKeyword({ db, orgId: 'org_1', term: 'acme', kind: 'brand' })).rejects.toThrow(
      'no such table',
    );
  });
});

describe('deleteKeyword', () => {
  it('looks up orphans, then deletes org-scoped matches and the keyword in one batch', async () => {
    const { db, queries } = createDbStub((query) => {
      if (query.sql.startsWith('SELECT')) return { results: [] }; // no orphaned mentions
      if (query.sql.includes('FROM keywords')) return { changes: 1 };
      return { changes: 3 };
    });
    const deleted = await deleteKeyword({ db, orgId: 'org_1', keywordId: 'kw_1' });
    expect(deleted).toBe(true);
    expect(queries).toHaveLength(3);
    // Orphan lookup runs first and is guarded against mentions matched elsewhere.
    expect(queries[0]!.sql).toContain('NOT EXISTS');
    expect(queries[0]!.params).toEqual(['org_1', 'kw_1', 'org_1', 'kw_1']);
    expect(queries[1]!.sql).toContain('DELETE FROM mention_matches');
    expect(queries[2]!.sql).toContain('DELETE FROM keywords');
    // Nothing to clean up when the lookup is empty.
    expect(queries.some((q) => q.sql.includes('DELETE FROM mentions'))).toBe(false);
  });

  it('deletes mentions left orphaned once the keyword is removed', async () => {
    const { db, queries } = createDbStub((query) => {
      if (query.sql.startsWith('SELECT')) return { results: [{ id: 'men_1' }, { id: 'men_2' }] };
      if (query.sql.includes('FROM keywords')) return { changes: 1 };
      return { changes: 2 };
    });
    const deleted = await deleteKeyword({ db, orgId: 'org_1', keywordId: 'kw_1' });
    expect(deleted).toBe(true);

    const mentionsDelete = queries.find((q) => q.sql.includes('DELETE FROM mentions'));
    expect(mentionsDelete).toBeDefined();
    expect(mentionsDelete!.params).toEqual(['men_1', 'men_2']);

    // FK ordering: the matches (child) must be deleted before the mentions (parent).
    const matchesIdx = queries.findIndex((q) => q.sql.includes('DELETE FROM mention_matches'));
    const mentionsIdx = queries.findIndex((q) => q.sql.includes('DELETE FROM mentions'));
    expect(matchesIdx).toBeLessThan(mentionsIdx);
  });

  it('chunks orphan deletes under the D1 bound-parameter cap', async () => {
    const orphans = Array.from({ length: 200 }, (_, i) => ({ id: `men_${i}` }));
    const { db, queries } = createDbStub((query) => {
      if (query.sql.startsWith('SELECT')) return { results: orphans };
      if (query.sql.includes('FROM keywords')) return { changes: 1 };
      return { changes: 1 };
    });
    await deleteKeyword({ db, orgId: 'org_1', keywordId: 'kw_1' });

    const mentionDeletes = queries.filter((q) => q.sql.includes('DELETE FROM mentions'));
    expect(mentionDeletes).toHaveLength(3); // 200 ids -> 90 + 90 + 20
    for (const del of mentionDeletes) {
      expect(del.params.length).toBeLessThanOrEqual(90);
    }
    expect(mentionDeletes.flatMap((d) => d.params)).toHaveLength(200);
  });

  it('returns false when the keyword does not exist for the org', async () => {
    const { db } = createDbStub((query) => (query.sql.startsWith('SELECT') ? { results: [] } : { changes: 0 }));
    expect(await deleteKeyword({ db, orgId: 'org_1', keywordId: 'kw_missing' })).toBe(false);
  });
});

describe('setKeywordMuted', () => {
  it('writes 1/0 for the muted flag', async () => {
    const { db, queries } = createDbStub(() => ({ changes: 1 }));
    await setKeywordMuted({ db, orgId: 'org_1', keywordId: 'kw_1', muted: true });
    expect(queries[0]!.params).toEqual([1, 'kw_1', 'org_1']);
  });
});

describe('listActiveTermsWithSubscribers', () => {
  it('groups unmuted keywords across orgs by normalized term', async () => {
    const { db, queries } = createDbStub(() => ({
      results: [
        { normalized_term: 'acme', org_id: 'org_1', id: 'kw_1' },
        { normalized_term: 'acme', org_id: 'org_2', id: 'kw_9' },
        { normalized_term: 'zernio', org_id: 'org_1', id: 'kw_2' },
      ],
    }));

    const terms = await listActiveTermsWithSubscribers({ db });
    expect(queries[0]!.sql).toContain('muted = 0');
    expect(terms).toEqual([
      {
        normalizedTerm: 'acme',
        subscribers: [
          { orgId: 'org_1', keywordId: 'kw_1' },
          { orgId: 'org_2', keywordId: 'kw_9' },
        ],
      },
      { normalizedTerm: 'zernio', subscribers: [{ orgId: 'org_1', keywordId: 'kw_2' }] },
    ]);
  });
});
