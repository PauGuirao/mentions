import { describe, expect, it } from 'vitest';
import fixture from '../__fixtures__/gdelt-search.json';
import { newsAdapter } from '../news';
import { stubFetch } from './stub-fetch';

describe('newsAdapter', () => {
  it('requires a term', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    await expect(newsAdapter.fetchSince({ cursor: null, fetchImpl })).rejects.toThrow(
      /without a term/,
    );
  });

  it('sends a quoted artlist query with startdatetime from the cursor, keyless', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await newsAdapter.fetchSince({
      cursor: String(Date.parse('2026-06-25T00:00:00Z')),
      term: 'zernio',
      fetchImpl,
    });
    const url = requests[0]?.url ?? '';
    expect(url).toContain('https://api.gdeltproject.org/api/v2/doc/doc');
    expect(url).toContain('query=%22zernio%22');
    expect(url).toContain('mode=artlist');
    expect(url).toContain('format=json');
    expect(url).toContain('sort=datedesc');
    expect(url).toContain('maxrecords=250');
    expect(url).toContain('startdatetime=20260625000000');
    expect(requests[0]?.headers['user-agent']).toContain('mentions');
  });

  it('maps articles (entities decoded, compact seendate parsed), skips malformed, sorts oldest-first', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await newsAdapter.fetchSince({
      cursor: String(Date.parse('2026-06-25T00:00:00Z')),
      term: 'zernio',
      fetchImpl,
    });

    // 4 fixture articles: 1 invalid url, 1 wrong-shape seendate.
    expect(items.map((i) => i.externalId)).toEqual([
      'article:https://www.theregister.com/2026/07/01/zernio_devtools/',
      'article:https://techcrunch.com/2026/07/02/zernio-seed/',
    ]);
    expect(items[1]).toMatchObject({
      source: 'news',
      url: 'https://techcrunch.com/2026/07/02/zernio-seed/',
      author: 'techcrunch.com',
      authorUrl: 'https://techcrunch.com',
      publishedAt: Date.parse('2026-07-02T08:30:00Z'),
    });
    expect(items[1]?.text).toBe('Zernio raises $5M seed & expands its API\n\ntechcrunch.com');
    expect(nextCursor).toBe(String(Date.parse('2026-07-02T08:30:00Z')));
  });

  it('treats a missing articles key and an empty body as empty polls, cursor kept', async () => {
    const { fetchImpl } = stubFetch({ responses: [{}, ''] });
    const first = await newsAdapter.fetchSince({ cursor: '1782050000000', term: 'zernio', fetchImpl });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBe('1782050000000');
    const second = await newsAdapter.fetchSince({ cursor: '1782050000000', term: 'zernio', fetchImpl });
    expect(second.items).toEqual([]);
    expect(second.nextCursor).toBe('1782050000000');
  });

  it('throws on a 200 with a plain-text body (GDELT reports query errors that way)', async () => {
    const { fetchImpl } = stubFetch({
      responses: ['Please limit requests to one every 5 seconds or contact ...'],
    });
    await expect(
      newsAdapter.fetchSince({ cursor: null, term: 'zernio', fetchImpl }),
    ).rejects.toThrow(/non-JSON body/);
  });

  it('throws on the shared-egress 429 so the ingest retry clears the window', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('Please limit requests to one every 5 seconds', { status: 429 });
    await expect(
      newsAdapter.fetchSince({ cursor: null, term: 'zernio', fetchImpl }),
    ).rejects.toThrow(/responded 429/);
  });
});
