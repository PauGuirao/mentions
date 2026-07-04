import { describe, expect, it } from 'vitest';
import fixture from '../__fixtures__/hackernews-search.json';
import { hackernewsAdapter } from '../hackernews';
import { stubFetch } from './stub-fetch';

describe('hackernewsAdapter', () => {
  it('queries Algolia inclusively from the cursor second', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await hackernewsAdapter.fetchSince({ cursor: '1782899000', fetchImpl });
    expect(requests[0]?.url).toContain('hn.algolia.com/api/v1/search_by_date');
    expect(requests[0]?.url).toContain('created_at_i%3E%3D1782899000');
    expect(requests[0]?.url).toContain('tags=%28story%2Ccomment%29');
  });

  it('normalizes stories and comments oldest-first, strips HTML, skips malformed hits', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await hackernewsAdapter.fetchSince({
      cursor: '1782899000',
      fetchImpl,
    });

    // Fixture has 3 hits newest-first; the newest one is malformed (no objectID).
    expect(items.map((i) => i.externalId)).toEqual(['44001001', '44001002']);

    expect(items[0]).toMatchObject({
      source: 'hackernews',
      url: 'https://news.ycombinator.com/item?id=44001001',
      author: 'founder123',
      authorUrl: 'https://news.ycombinator.com/user?id=founder123',
      publishedAt: 1782900000000,
      text: 'Show HN: Zernio, schedule posts via API\n\nWe built an API-first scheduler. Ask me anything!',
    });

    // Comment: HTML tags stripped, entities decoded, no title prefix.
    expect(items[1]?.text).toBe("I switched to Zernio last month & it's been great.");

    // Cursor advances to the newest hit that parsed; the malformed (newer)
    // hit cannot contribute a timestamp.
    expect(nextCursor).toBe('1782900300');
  });

  it('keeps the cursor when the poll returns nothing', async () => {
    const { fetchImpl } = stubFetch({ responses: [{ hits: [] }] });
    const { items, nextCursor } = await hackernewsAdapter.fetchSince({
      cursor: '1782899000',
      fetchImpl,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1782899000');
  });

  it('bootstraps with a lookback window when cursor is null', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [{ hits: [] }] });
    const before = Math.floor(Date.now() / 1000) - 600;
    const { nextCursor } = await hackernewsAdapter.fetchSince({ cursor: null, fetchImpl });
    expect(requests[0]?.url).toContain('created_at_i%3E%3D');
    expect(Number(nextCursor)).toBeGreaterThanOrEqual(before);
  });
});
