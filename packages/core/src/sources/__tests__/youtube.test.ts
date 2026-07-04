import { describe, expect, it } from 'vitest';
import fixture from '../__fixtures__/youtube-search.json';
import { youtubeAdapter } from '../youtube';
import { stubFetch } from './stub-fetch';

/** stubFetch always replies 200, so error-path tests build their own stub. */
function errorFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const QUOTA_ERROR = {
  error: {
    code: 403,
    message: 'The request cannot be completed because you have exceeded your quota.',
    errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }],
  },
};

describe('youtubeAdapter', () => {
  it('requires a term', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    await expect(
      youtubeAdapter.fetchSince({ cursor: null, fetchImpl, auth: 'yt-key' }),
    ).rejects.toThrow(/without a term/);
  });

  it('defers without an API key: no requests, cursor kept', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await youtubeAdapter.fetchSince({
      cursor: '1782000000000',
      term: 'zernio',
      fetchImpl,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1782000000000');
    expect(requests).toHaveLength(0);
  });

  it('sends a quoted video search with publishedAfter from the cursor and the key', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    const cursorMs = Date.parse('2026-06-25T00:00:00Z');
    await youtubeAdapter.fetchSince({
      cursor: String(cursorMs),
      term: 'zernio',
      fetchImpl,
      auth: 'yt-key',
    });
    const url = requests[0]?.url ?? '';
    expect(url).toContain('https://www.googleapis.com/youtube/v3/search');
    expect(url).toContain('part=snippet');
    expect(url).toContain('q=%22zernio%22');
    expect(url).toContain('type=video');
    expect(url).toContain('order=date');
    expect(url).toContain(`publishedAfter=${encodeURIComponent('2026-06-25T00:00:00Z')}`);
    expect(url).toContain('key=yt-key');
  });

  it('maps videos (entities decoded, channel author), skips non-video results, sorts oldest-first', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await youtubeAdapter.fetchSince({
      cursor: String(Date.parse('2026-06-25T00:00:00Z')),
      term: 'zernio',
      fetchImpl,
      auth: 'yt-key',
    });

    // 3 fixture items: 1 is a channel result without a videoId.
    expect(items.map((i) => i.externalId)).toEqual(['video:aB3cD5eF7gH', 'video:dQw4w9WgXcQ']);
    expect(items[1]).toMatchObject({
      source: 'youtube',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      author: 'Katie Codes',
      authorUrl: 'https://www.youtube.com/channel/UCkatie123',
      publishedAt: Date.parse('2026-07-02T08:30:00Z'),
    });
    // search.list titles are entity-encoded; the adapter decodes them.
    expect(items[1]?.text).toBe(
      "Zernio review: it's good & cheap\n\nFull walkthrough of Zernio for scheduling posts across platforms.",
    );
    expect(nextCursor).toBe(String(Date.parse('2026-07-02T08:30:00Z')));
  });

  it('defers on 403 quotaExceeded: cursor kept, no throw', async () => {
    const { fetchImpl } = errorFetch(403, QUOTA_ERROR);
    const { items, nextCursor } = await youtubeAdapter.fetchSince({
      cursor: '1782000000000',
      term: 'zernio',
      fetchImpl,
      auth: 'yt-key',
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1782000000000');
  });

  it('throws on a non-quota 403 (bad key) so the ingest retry surfaces it', async () => {
    const { fetchImpl } = errorFetch(403, {
      error: { code: 403, message: 'API key not valid.', errors: [{ reason: 'forbidden' }] },
    });
    await expect(
      youtubeAdapter.fetchSince({ cursor: null, term: 'zernio', fetchImpl, auth: 'bad-key' }),
    ).rejects.toThrow(/responded 403/);
  });

  it('keeps the cursor when nothing new matched', async () => {
    const { fetchImpl } = stubFetch({ responses: [{ items: [] }] });
    const { items, nextCursor } = await youtubeAdapter.fetchSince({
      cursor: '1782050000000',
      term: 'zernio',
      fetchImpl,
      auth: 'yt-key',
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1782050000000');
  });
});
