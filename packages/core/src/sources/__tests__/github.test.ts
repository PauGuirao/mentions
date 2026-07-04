import { describe, expect, it } from 'vitest';
import fixture from '../__fixtures__/github-search.json';
import { githubAdapter } from '../github';
import { stubFetch } from './stub-fetch';

describe('githubAdapter', () => {
  it('requires a term', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    await expect(githubAdapter.fetchSince({ cursor: null, fetchImpl })).rejects.toThrow(
      /without a term/,
    );
  });

  it('sends a quoted phrase query with mandatory headers and advanced_search', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await githubAdapter.fetchSince({ cursor: null, term: 'zernio', fetchImpl });
    const req = requests[0];
    expect(req?.url).toContain('api.github.com/search/issues');
    expect(req?.url).toContain('q=%22zernio%22+in%3Atitle%2Cbody');
    expect(req?.url).toContain('sort=created');
    expect(req?.url).toContain('advanced_search=true');
    expect(req?.headers['user-agent']).toBe('mentions-ingest');
    expect(req?.headers['authorization']).toBeUndefined();
  });

  it('passes the token as a Bearer header when auth is provided', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await githubAdapter.fetchSince({ cursor: null, term: 'zernio', fetchImpl, auth: 'ghp_test' });
    expect(requests[0]?.headers['authorization']).toBe('Bearer ghp_test');
  });

  it('filters client-side to the cursor, skips malformed items, returns oldest-first', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await githubAdapter.fetchSince({
      cursor: '2026-06-25T00:00:00Z',
      term: 'zernio',
      fetchImpl,
    });

    // 4 fixture items: 1 malformed (no html_url), 1 older than the cursor.
    expect(items.map((i) => i.externalId)).toEqual(['issue:3100200301', 'issue:3100200302']);
    expect(items[1]).toMatchObject({
      source: 'github',
      url: 'https://github.com/acme/social-tool/issues/87',
      author: 'octocat',
      authorUrl: 'https://github.com/octocat',
      text: 'Integrate Zernio API for post scheduling\n\nWe should use zernio instead of rolling our own scheduler.',
    });
    // Null body -> text is the title alone.
    expect(items[0]?.text).toBe('Does anyone use Zernio?');
    expect(nextCursor).toBe('2026-07-02T08:30:00Z');
  });

  it('keeps the cursor when nothing new matched', async () => {
    const { fetchImpl } = stubFetch({ responses: [{ total_count: 0, items: [] }] });
    const { items, nextCursor } = await githubAdapter.fetchSince({
      cursor: '2026-07-03T00:00:00Z',
      term: 'zernio',
      fetchImpl,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('2026-07-03T00:00:00Z');
  });
});
