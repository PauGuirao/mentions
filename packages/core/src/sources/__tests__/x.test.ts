import { describe, expect, it } from 'vitest';
import fixture from '../__fixtures__/x-search.json';
import type { BudgetMeter } from '../types';
import { xAdapter } from '../x';
import { stubFetch } from './stub-fetch';

/** BudgetMeter stub that reports a fixed remaining and records debits. */
function stubMeter(remaining: number): { meter: BudgetMeter; recorded: number[] } {
  const recorded: number[] = [];
  return {
    meter: {
      remaining: async () => remaining,
      record: async (units) => {
        recorded.push(units);
      },
    },
    recorded,
  };
}

describe('xAdapter', () => {
  it('requires a term', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    await expect(
      xAdapter.fetchSince({ cursor: null, fetchImpl, auth: 'bearer-test' }),
    ).rejects.toThrow(/without a term/);
  });

  it('defers without a bearer token: no requests, cursor kept', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await xAdapter.fetchSince({
      cursor: '1940000000000000000',
      term: 'zernio',
      fetchImpl,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1940000000000000000');
    expect(requests).toHaveLength(0);
  });

  it('defers when the monthly read budget is exhausted: no requests, cursor kept', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    const { meter, recorded } = stubMeter(0);
    const { items, nextCursor } = await xAdapter.fetchSince({
      cursor: '1940000000000000000',
      term: 'zernio',
      fetchImpl,
      auth: 'bearer-test',
      budget: meter,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1940000000000000000');
    expect(requests).toHaveLength(0);
    expect(recorded).toEqual([]);
  });

  it('sends a quoted retweet-free query with since_id and the Bearer header', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await xAdapter.fetchSince({
      cursor: '1940000000000000000',
      term: 'zernio',
      fetchImpl,
      auth: 'bearer-test',
    });
    const req = requests[0];
    expect(req?.url).toContain('https://api.x.com/2/tweets/search/recent');
    expect(req?.url).toContain('query=%22zernio%22+-is%3Aretweet');
    expect(req?.url).toContain('max_results=100');
    expect(req?.url).toContain('since_id=1940000000000000000');
    expect(req?.url).not.toContain('start_time');
    expect(req?.headers['authorization']).toBe('Bearer bearer-test');
  });

  it('bootstraps with a bounded start_time instead of the full 7-day window', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    await xAdapter.fetchSince({ cursor: null, term: 'zernio', fetchImpl, auth: 'bearer-test' });
    expect(requests[0]?.url).toContain('start_time=');
    expect(requests[0]?.url).not.toContain('since_id');
  });

  it('shrinks max_results toward the remaining budget and debits actual reads', async () => {
    const { fetchImpl, requests } = stubFetch({ responses: [fixture] });
    const { meter, recorded } = stubMeter(42);
    await xAdapter.fetchSince({
      cursor: '1940000000000000000',
      term: 'zernio',
      fetchImpl,
      auth: 'bearer-test',
      budget: meter,
    });
    expect(requests[0]?.url).toContain('max_results=42');
    // 3 posts returned (even the malformed one was a metered read).
    expect(recorded).toEqual([3]);
  });

  it('maps posts (author join via includes, URL fallback), skips malformed, sorts oldest-first', async () => {
    const { fetchImpl } = stubFetch({ responses: [fixture] });
    const { items, nextCursor } = await xAdapter.fetchSince({
      cursor: '1940000000000000000',
      term: 'zernio',
      fetchImpl,
      auth: 'bearer-test',
    });

    // 3 fixture posts: 1 malformed (no text/created_at).
    expect(items.map((i) => i.externalId)).toEqual([
      'tweet:1940102030405060699',
      'tweet:1940102030405060700',
    ]);
    expect(items[1]).toMatchObject({
      source: 'x',
      url: 'https://x.com/devkatie/status/1940102030405060700',
      author: 'Katie',
      authorUrl: 'https://x.com/devkatie',
      text: 'Just switched our whole pipeline to Zernio, night and day difference',
    });
    // author_id 999 has no user expansion -> /i/web/status URL, no author.
    expect(items[0]?.url).toBe('https://x.com/i/web/status/1940102030405060699');
    expect(items[0]?.author).toBeUndefined();
    expect(nextCursor).toBe('1940102030405060700');
  });

  it('keeps the cursor and debits nothing on an empty result', async () => {
    const { fetchImpl } = stubFetch({ responses: [{ meta: { result_count: 0 } }] });
    const { meter, recorded } = stubMeter(1000);
    const { items, nextCursor } = await xAdapter.fetchSince({
      cursor: '1940200000000000000',
      term: 'zernio',
      fetchImpl,
      auth: 'bearer-test',
      budget: meter,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBe('1940200000000000000');
    expect(recorded).toEqual([]);
  });
});
