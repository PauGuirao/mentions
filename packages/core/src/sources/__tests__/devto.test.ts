import { describe, expect, it } from 'vitest';
import fixture from '../__fixtures__/devto-latest.json';
import { devtoAdapter } from '../devto';
import { stubFetch } from './stub-fetch';

const CURSOR = String(Date.parse('2026-07-01T00:00:00Z'));

describe('devtoAdapter', () => {
  it('fetches /articles/latest and stops paginating on a short page', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await devtoAdapter.fetchSince({ cursor: CURSOR, fetchImpl });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://dev.to/api/articles/latest?page=1&per_page=100');
  });

  it('filters to the cursor, handles both tag_list shapes, returns oldest-first', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await devtoAdapter.fetchSince({ cursor: CURSOR, fetchImpl });

    // 4 fixture articles: 1 older than the cursor, 1 malformed (no url).
    expect(items.map((i) => i.externalId)).toEqual(['2200290', '2200300']);

    expect(items[1]).toMatchObject({
      source: 'devto',
      url: 'https://dev.to/samdev/automating-my-content-pipeline-with-zernio-1abc',
      author: 'Sam Dev',
      authorUrl: 'https://dev.to/samdev',
      publishedAt: Date.parse('2026-07-02T07:45:00Z'),
    });
    // Array-shaped tag_list.
    expect(items[1]?.text).toBe(
      'Automating my content pipeline with Zernio\n\nHow I schedule a week of posts in one sitting.\n\n#automation #webdev',
    );
    // Comma-string-shaped tag_list.
    expect(items[0]?.text).toBe(
      'Social APIs compared\n\nZernio vs Buffer vs Typefully.\n\n#api #social #comparison',
    );

    expect(nextCursor).toBe(String(Date.parse('2026-07-02T07:45:00Z')));
  });

  it('keeps the cursor when the feed has nothing new', async () => {
    const { fetchImpl } = stubFetch({ responses: [[]] });
    const cursor = String(Date.parse('2026-07-03T00:00:00Z'));
    const { items, nextCursor } = await devtoAdapter.fetchSince({ cursor, fetchImpl });
    expect(items).toEqual([]);
    expect(nextCursor).toBe(cursor);
  });
});
