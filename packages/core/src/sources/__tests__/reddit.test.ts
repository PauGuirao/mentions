import { describe, expect, it } from 'vitest';
import searchFixture from '../__fixtures__/reddit-search.json';
import tokenFixture from '../__fixtures__/reddit-token.json';
import { redditAdapter } from '../reddit';
import { stubFetch } from './stub-fetch';

// The adapter caches the app token at module scope keyed by the auth string,
// so every test that exchanges a token uses its OWN credentials — tests stay
// independent of execution order.

const EMPTY_LISTING = { kind: 'Listing', data: { after: null, children: [] } };

describe('redditAdapter', () => {
  it('requires a term', async () => {
    const { fetchImpl } = stubFetch({ responses: [tokenFixture] });
    await expect(redditAdapter.fetchSince({ cursor: null, fetchImpl })).rejects.toThrow(
      /without a term/,
    );
  });

  it('defers without credentials: no requests, cursor kept', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [searchFixture] });
    const { items, nextCursor } = await redditAdapter.fetchSince({
      cursor: '1782000000',
      term: 'zernio',
      fetchImpl,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1782000000');
    expect(requests).toHaveLength(0);
  });

  it('exchanges the app token (Basic auth + UA) then searches with it', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [tokenFixture, searchFixture] });
    await redditAdapter.fetchSince({
      cursor: null,
      term: 'zernio',
      fetchImpl,
      auth: 'id-exchange:secret-exchange',
    });

    expect(requests[0]?.url).toBe('https://www.reddit.com/api/v1/access_token');
    expect(requests[0]?.headers['authorization']).toBe(
      `Basic ${btoa('id-exchange:secret-exchange')}`,
    );
    expect(requests[0]?.headers['user-agent']).toContain('mentions');

    expect(requests[1]?.url).toContain('https://oauth.reddit.com/search');
    expect(requests[1]?.url).toContain('q=%22zernio%22');
    expect(requests[1]?.url).toContain('sort=new');
    expect(requests[1]?.url).toContain('type=link');
    expect(requests[1]?.url).toContain('raw_json=1');
    expect(requests[1]?.headers['authorization']).toBe('Bearer reddit-app-token');
    expect(requests[1]?.headers['user-agent']).toContain('mentions');
  });

  it('reuses the cached token across polls with the same credentials', async () => {
    const { fetchImpl, requests } = stubFetch({
      responses: [tokenFixture, searchFixture, searchFixture],
    });
    const args = { term: 'zernio', fetchImpl, auth: 'id-cache:secret-cache' };
    await redditAdapter.fetchSince({ cursor: null, ...args });
    await redditAdapter.fetchSince({ cursor: '1782035400', ...args });

    // token, search, search — no second exchange.
    expect(requests).toHaveLength(3);
    expect(requests[2]?.url).toContain('oauth.reddit.com/search');
  });

  it('filters to the cursor, skips malformed posts, omits [deleted] authors, sorts oldest-first', async () => {
    const { fetchImpl } = stubFetch({ responses: [tokenFixture, searchFixture] });
    const { items, nextCursor } = await redditAdapter.fetchSince({
      cursor: '1782000000',
      term: 'zernio',
      fetchImpl,
      auth: 'id-map:secret-map',
    });

    // 4 fixture children: 1 malformed, 1 older than the cursor.
    expect(items.map((i) => i.externalId)).toEqual(['post:1lqdel9', 'post:1lqnew1']);
    expect(items[1]).toMatchObject({
      source: 'reddit',
      url: 'https://www.reddit.com/r/webdev/comments/1lqnew1/has_anyone_tried_zernio_for_scheduling/',
      author: 'devkatie',
      authorUrl: 'https://www.reddit.com/user/devkatie',
      publishedAt: 1782035400000,
    });
    expect(items[1]?.text).toBe(
      'Has anyone tried Zernio for scheduling posts?\n\nComparing Zernio vs Buffer & Hootsuite for a client. Thoughts?\n\nr/webdev',
    );
    // [deleted] author -> no author fields; empty selftext -> title + subreddit.
    expect(items[0]?.author).toBeUndefined();
    expect(items[0]?.authorUrl).toBeUndefined();
    expect(items[0]?.text).toBe('Zernio pricing thread\n\nr/marketing');
    expect(nextCursor).toBe('1782035400');
  });

  it('keeps the cursor when nothing new matched', async () => {
    const { fetchImpl } = stubFetch({ responses: [tokenFixture, EMPTY_LISTING] });
    const { items, nextCursor } = await redditAdapter.fetchSince({
      cursor: '1782050000',
      term: 'zernio',
      fetchImpl,
      auth: 'id-empty:secret-empty',
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1782050000');
  });
});
