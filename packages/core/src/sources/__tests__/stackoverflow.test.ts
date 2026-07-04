import { describe, expect, it } from 'vitest';
import fixture from '../__fixtures__/stackoverflow-excerpts.json';
import lowQuotaFixture from '../__fixtures__/stackoverflow-low-quota.json';
import { stackoverflowAdapter } from '../stackoverflow';
import { stubFetch } from './stub-fetch';

describe('stackoverflowAdapter', () => {
  it('requires a term', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    await expect(stackoverflowAdapter.fetchSince({ cursor: null, fetchImpl })).rejects.toThrow(
      /without a term/,
    );
  });

  it('queries /search/excerpts with fromdate = cursor (inclusive)', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await stackoverflowAdapter.fetchSince({ cursor: '1782700000', term: 'zernio', fetchImpl });
    const url = requests[0]?.url ?? '';
    expect(url).toContain('api.stackexchange.com/2.3/search/excerpts');
    expect(url).toContain('q=zernio');
    expect(url).toContain('site=stackoverflow');
    expect(url).toContain('sort=creation');
    expect(url).toContain('order=asc');
    expect(url).toContain('fromdate=1782700000');
  });

  it('normalizes questions and answers, decodes entities, skips malformed items', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await stackoverflowAdapter.fetchSince({
      cursor: '1782700000',
      term: 'zernio',
      fetchImpl,
    });

    expect(items.map((i) => i.externalId)).toEqual(['question:79600100', 'answer:79600222']);
    expect(items[0]).toMatchObject({
      source: 'stackoverflow',
      url: 'https://stackoverflow.com/questions/79600100',
      author: 'Jane Dév',
      authorUrl: 'https://stackoverflow.com/users/222/jane-dev',
      publishedAt: 1782800000000,
      text: 'How do I schedule posts with the "Zernio" API?\n\nI\'m using the Zernio REST API and can\'t figure out cron...',
    });
    expect(items[1]?.url).toBe('https://stackoverflow.com/a/79600222');
    expect(nextCursor).toBe('1782810000');
  });

  it('defers (same cursor, no items) when quota_remaining drops below 10', async () => {
    const { fetchImpl } = stubFetch({ responses: [lowQuotaFixture] });
    const { items, nextCursor } = await stackoverflowAdapter.fetchSince({
      cursor: '1782700000',
      term: 'zernio',
      fetchImpl,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1782700000');
  });

  it('sends the API key when auth is provided', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await stackoverflowAdapter.fetchSince({
      cursor: '1782700000',
      term: 'zernio',
      fetchImpl,
      auth: 'se-key-123',
    });
    expect(requests[0]?.url).toContain('key=se-key-123');
  });
});
