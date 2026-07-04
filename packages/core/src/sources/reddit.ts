/**
 * Reddit post search via the official OAuth API (GET /search on
 * oauth.reddit.com, https://www.reddit.com/dev/api#GET_search), polled per
 * normalized term.
 *
 * Auth: `auth` is "client_id:client_secret" of the Reddit app. The adapter
 * exchanges it for an app-only bearer token (grant_type=client_credentials)
 * and caches the token at module scope until shortly before its ~24h expiry,
 * so the exchange amortizes across polls in the same isolate. While the app
 * application is pending (no credentials configured) every poll DEFERS —
 * warn + same cursor, no requests — so ingestion starts on the first poll
 * after `wrangler secret put REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET`, zero
 * deploys needed.
 *
 * Cursor: `created_utc` (epoch SECONDS) of the newest ingested post. /search
 * has no since parameter, so we fetch newest-first (sort=new) and filter
 * client-side with an INCLUSIVE compare; boundary posts refetch and dedupe
 * downstream. First poll takes the newest page as a bounded bootstrap.
 *
 * Quirks:
 * - Only posts (t3) are searchable; the official API has no comment search.
 * - `raw_json=1` disables Reddit's default HTML entity encoding, so text
 *   fields arrive literal — no decodeEntities pass needed.
 * - The API rules require a descriptive, unique User-Agent; default library
 *   UAs get throttled hard.
 * - Deleted/removed posts keep author "[deleted]" — author fields are omitted.
 * - A 401 on search means the cached token was invalidated server-side: drop
 *   the cache and throw, so the ingest retry re-authenticates.
 */
import { z } from 'zod';
import type { RawItem } from '../schemas';
import type { SourceAdapter } from './types';
import { clampText, finalizeItems } from './util';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const SEARCH_URL = 'https://oauth.reddit.com/search';
const USER_AGENT = 'web:mentions-ingest:v0.1 (+https://github.com/PauGuirao/mentions)';
const PAGE_SIZE = 100;
/** Refresh this long before expiry so a token never lapses mid-poll. */
const TOKEN_SLACK_MS = 60_000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const redditChildSchema = z.object({ kind: z.string(), data: z.unknown() });

const redditPostSchema = z.object({
  id: z.string().min(1),
  permalink: z.string().startsWith('/'),
  title: z.string(),
  selftext: z.string().nullish(),
  created_utc: z.number().positive(),
  author: z.string().nullish(),
  subreddit: z.string().nullish(),
});

const redditListingSchema = z.object({
  data: z.object({ children: z.array(z.unknown()) }),
});

/** Single-slot cache (prod runs one credential set); keyed by auth so rotated
 *  credentials take effect immediately. */
let tokenCache: { auth: string; token: string; expiresAtMs: number } | null = null;

async function getAppToken(auth: string, doFetch: typeof fetch): Promise<string> {
  if (
    tokenCache &&
    tokenCache.auth === auth &&
    Date.now() < tokenCache.expiresAtMs - TOKEN_SLACK_MS
  ) {
    return tokenCache.token;
  }
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(auth)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`reddit: token exchange responded ${res.status}`);
  }
  const body = tokenResponseSchema.parse(await res.json());
  tokenCache = { auth, token: body.access_token, expiresAtMs: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

export const redditAdapter: SourceAdapter = {
  source: 'reddit',
  kind: 'per-term',
  async fetchSince({ cursor, term, fetchImpl, auth }) {
    if (!term) {
      throw new Error('reddit: per-term adapter called without a term');
    }
    if (!auth) {
      console.warn(`[sources:reddit] no API credentials configured; deferring poll for "${term}"`);
      return { items: [], nextCursor: cursor };
    }
    const doFetch = fetchImpl ?? fetch;
    const sinceSec = cursor !== null ? Number.parseInt(cursor, 10) : 0;

    const token = await getAppToken(auth, doFetch);

    // Quote the term for phrase matching; embedded quotes would break the
    // query syntax, so drop them (same policy as the github adapter).
    const phrase = term.replace(/"/g, '');
    const params = new URLSearchParams({
      q: `"${phrase}"`,
      sort: 'new',
      type: 'link',
      limit: String(PAGE_SIZE),
      raw_json: '1',
    });
    const res = await doFetch(`${SEARCH_URL}?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (res.status === 401) {
      tokenCache = null;
      throw new Error('reddit: search responded 401 (token invalidated); will re-authenticate');
    }
    if (!res.ok) {
      throw new Error(`reddit: search responded ${res.status}`);
    }
    const body = redditListingSchema.parse(await res.json());

    let maxCreatedSec = 0;
    const candidates = body.data.children.map((raw): RawItem | null => {
      const child = redditChildSchema.safeParse(raw);
      if (!child.success || child.data.kind !== 't3') return null;
      const post = redditPostSchema.safeParse(child.data.data);
      if (!post.success) return null;
      const p = post.data;
      if (p.created_utc < sinceSec) return null;
      if (p.created_utc > maxCreatedSec) maxCreatedSec = p.created_utc;

      const text = clampText(
        [p.title.trim(), p.selftext?.trim() ?? '', p.subreddit ? `r/${p.subreddit}` : '']
          .filter(Boolean)
          .join('\n\n'),
      );
      if (!text) return null;

      const author = p.author && p.author !== '[deleted]' ? p.author : undefined;
      return {
        source: 'reddit',
        externalId: `post:${p.id}`,
        url: `https://www.reddit.com${p.permalink}`,
        text,
        // created_utc is a float; publishedAt must be an int (epoch ms).
        publishedAt: Math.round(p.created_utc * 1000),
        ...(author ? { author, authorUrl: `https://www.reddit.com/user/${author}` } : {}),
      };
    });

    const items = finalizeItems({ source: 'reddit', candidates });
    const nextCursor = maxCreatedSec > 0 ? String(Math.floor(maxCreatedSec)) : cursor;
    return { items, nextCursor };
  },
};
