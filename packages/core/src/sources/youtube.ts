/**
 * YouTube video search via the Data API v3 (GET /youtube/v3/search,
 * https://developers.google.com/youtube/v3/docs/search/list), polled per
 * normalized term.
 *
 * Auth: `auth` is a plain API key (sent as `key=`), no OAuth needed for
 * search. Until the key is configured every poll DEFERS (warn + same cursor,
 * no requests) — enabling the source is `wrangler secret put
 * YOUTUBE_API_KEY`, no deploy.
 *
 * QUOTA IS THE BUDGET: search.list costs 100 units against a 10,000/day
 * default project quota, i.e. ~100 searches/day TOTAL. That's why the
 * scheduler polls this source on a coarse cadence, and why a 403
 * quotaExceeded response DEFERS (same cursor, no items) instead of throwing —
 * retrying a quota error inside one poll can never succeed; the un-advanced
 * cursor re-covers the window after the daily reset. Deferral, not loss.
 *
 * Cursor: epoch MILLISECONDS of the newest ingested video's publishedAt, as
 * a string. Passed back as `publishedAfter` — documented as "at or after",
 * so INCLUSIVE: the boundary video refetches and dedupes downstream. First
 * poll looks back 24 hours. One page per poll on purpose; >50 new videos for
 * one term in one window is ceded to the quota.
 *
 * Quirks:
 * - search.list snippet TITLES are HTML-entity encoded (videos.list is not —
 *   a long-standing API inconsistency), so titles and descriptions go
 *   through decodeEntities.
 * - snippet.description is truncated by the search endpoint (~160 chars);
 *   the full description would cost an extra videos.list unit per video and
 *   the search already matched the term, so we keep the excerpt.
 * - With type=video every item id should carry videoId; validated anyway.
 */
import { z } from 'zod';
import type { RawItem } from '../schemas';
import type { SourceAdapter } from './types';
import { clampText, decodeEntities, finalizeItems, ADAPTER_HEADERS } from './util';

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const BOOTSTRAP_LOOKBACK_MS = 86_400_000;
/** API maximum for search.list. */
const PAGE_SIZE = 50;

const youtubeItemSchema = z.object({
  id: z.object({ videoId: z.string().min(1) }),
  snippet: z.object({
    publishedAt: z.string(),
    title: z.string(),
    description: z.string(),
    channelId: z.string().optional(),
    channelTitle: z.string().optional(),
  }),
});

const youtubeResponseSchema = z.object({ items: z.array(z.unknown()) });

const youtubeErrorSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** Quota-family 403 reasons; anything else on a 403 is a real error (bad key,
 *  API not enabled) and must throw loudly. */
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded']);

async function isQuotaError(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const parsed = youtubeErrorSchema.safeParse(await res.json());
    if (!parsed.success) return false;
    return (parsed.data.error.errors ?? []).some((e) => e.reason && QUOTA_REASONS.has(e.reason));
  } catch {
    return false;
  }
}

export const youtubeAdapter: SourceAdapter = {
  source: 'youtube',
  kind: 'per-term',
  async fetchSince({ cursor, term, fetchImpl, auth }) {
    if (!term) {
      throw new Error('youtube: per-term adapter called without a term');
    }
    if (!auth) {
      console.warn(`[sources:youtube] no API key configured; deferring poll for "${term}"`);
      return { items: [], nextCursor: cursor };
    }
    const doFetch = fetchImpl ?? fetch;
    const sinceMs = cursor !== null ? Number.parseInt(cursor, 10) : Date.now() - BOOTSTRAP_LOOKBACK_MS;

    // Quote the term for phrase matching; embedded quotes would break the
    // query syntax, so drop them (same policy as the github adapter).
    const phrase = term.replace(/"/g, '');
    const params = new URLSearchParams({
      part: 'snippet',
      q: `"${phrase}"`,
      type: 'video',
      order: 'date',
      maxResults: String(PAGE_SIZE),
      // The API documents second granularity for timestamps — strip the ms.
      publishedAfter: new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      key: auth,
    });

    const res = await doFetch(`${SEARCH_URL}?${params}`, { headers: ADAPTER_HEADERS });
    if (!res.ok) {
      if (await isQuotaError(res)) {
        console.warn(`[sources:youtube] daily quota exhausted; deferring poll for "${term}"`);
        return { items: [], nextCursor: cursor };
      }
      throw new Error(`youtube: search responded ${res.status}`);
    }
    const body = youtubeResponseSchema.parse(await res.json());

    let newestMs = 0;
    const candidates = body.items.map((raw): RawItem | null => {
      const parsed = youtubeItemSchema.safeParse(raw);
      if (!parsed.success) return null;
      const { id, snippet } = parsed.data;
      const publishedMs = Date.parse(snippet.publishedAt);
      if (Number.isNaN(publishedMs)) return null;
      if (publishedMs > newestMs) newestMs = publishedMs;

      const text = clampText(
        [decodeEntities(snippet.title).trim(), decodeEntities(snippet.description).trim()]
          .filter(Boolean)
          .join('\n\n'),
      );
      if (!text) return null;

      return {
        source: 'youtube',
        externalId: `video:${id.videoId}`,
        url: `https://www.youtube.com/watch?v=${id.videoId}`,
        text,
        publishedAt: publishedMs,
        ...(snippet.channelTitle ? { author: decodeEntities(snippet.channelTitle) } : {}),
        ...(snippet.channelId
          ? { authorUrl: `https://www.youtube.com/channel/${snippet.channelId}` }
          : {}),
      };
    });

    const items = finalizeItems({ source: 'youtube', candidates });
    const nextCursor = newestMs > 0 ? String(newestMs) : cursor;
    return { items, nextCursor };
  },
};
