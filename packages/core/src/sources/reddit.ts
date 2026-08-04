/**
 * Reddit post search, with TWO transports behind one parser (the direct vs
 * provider split from CLAUDE.md — nothing outside this file knows which ran):
 *
 * - `direct`: the official OAuth API (GET /search on oauth.reddit.com,
 *   https://www.reddit.com/dev/api#GET_search). Preferred when Reddit app
 *   credentials exist: free, sanctioned, no per-request cost.
 * - `provider`: the public search.json endpoint fetched through Zyte. Reddit
 *   403s any datacenter IP / non-browser TLS handshake, so a plain Workers
 *   fetch cannot reach it (verified 2026-08); Zyte supplies the residential
 *   IP + browser TLS. Costs money per request, hence the budget meter.
 *
 * Both return the SAME listing JSON shape, so only the transport differs.
 *
 * Auth: `auth` is "client_id:client_secret" of the Reddit app for the direct
 * path; the provider path takes `providerKey` instead. With neither, every
 * poll DEFERS — warn + same cursor, no requests — so turning Reddit on is a
 * `wrangler secret put` (REDDIT_CLIENT_ID/SECRET or ZYTE_API_KEY), zero
 * deploys. The direct path is tried first when both are configured.
 *
 * The app token is cached at module scope until shortly before its ~24h
 * expiry, so the exchange amortizes across polls in the same isolate.
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
import { zyteFetchText } from '../zyte';
import { parseRedditSearchHtml } from './reddit-html';
import type { SourceAdapter } from './types';
import { clampText, finalizeItems } from './util';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const SEARCH_URL = 'https://oauth.reddit.com/search';
/** Public mirror of the same search, reachable only through the provider. */
const PUBLIC_SEARCH_URL = 'https://www.reddit.com/search.json';
const USER_AGENT = 'web:mentions-ingest:v0.1 (+https://github.com/PauGuirao/mentions)';
const PAGE_SIZE = 100;

/** Default monthly cap on PAID provider requests. At the scheduler's 30-min
 *  reddit cadence one term burns ~1,440/month, so this is roughly 3 terms of
 *  headroom; raise it with REDDIT_MONTHLY_REQUEST_CAP on the ingest worker as
 *  tracked terms grow. Costs nothing when official credentials are set. */
export const REDDIT_DEFAULT_MONTHLY_REQUEST_CAP = 5_000;
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

/** Both transports normalize to this before the shared item mapping, so the
 *  RawItem shape is built in exactly one place. */
interface RedditPost {
  id: string;
  title: string;
  body: string;
  /** Epoch SECONDS (the cursor unit). */
  createdSec: number;
  author: string | null;
  subreddit: string | null;
  /** Absolute www permalink. */
  url: string;
}

/** Phrase-quoted query. Embedded quotes would break the syntax, so they are
 *  dropped (same policy as the github adapter). */
const quotedPhrase = (term: string): string => `"${term.replace(/"/g, '')}"`;

/** direct: official OAuth API (JSON). */
async function fetchDirect(args: {
  auth: string;
  term: string;
  doFetch: typeof fetch;
}): Promise<RedditPost[]> {
  const token = await getAppToken(args.auth, args.doFetch);
  const params = new URLSearchParams({
    q: quotedPhrase(args.term),
    sort: 'new',
    type: 'link',
    limit: String(PAGE_SIZE),
    raw_json: '1',
  });
  const res = await args.doFetch(`${SEARCH_URL}?${params}`, {
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
  const posts: RedditPost[] = [];
  for (const raw of body.data.children) {
    const child = redditChildSchema.safeParse(raw);
    if (!child.success || child.data.kind !== 't3') continue;
    const parsed = redditPostSchema.safeParse(child.data.data);
    if (!parsed.success) continue;
    const p = parsed.data;
    posts.push({
      id: p.id,
      title: p.title,
      body: p.selftext ?? '',
      createdSec: p.created_utc,
      author: p.author ?? null,
      subreddit: p.subreddit ?? null,
      url: `https://www.reddit.com${p.permalink}`,
    });
  }
  return posts;
}

/**
 * provider: old.reddit's search HTML through the scrape provider. Reddit
 * hard-blocks its .json endpoints even via residential IPs (verified
 * 2026-08), while the HTML renders fine — and old.reddit's listing carries
 * every field the API gave us, selftext included. See reddit-html.ts.
 */
async function fetchViaProvider(args: {
  providerKey: string;
  term: string;
  doFetch: typeof fetch;
}): Promise<RedditPost[]> {
  const params = new URLSearchParams({
    q: quotedPhrase(args.term),
    sort: 'new',
    t: 'all',
  });
  const html = await zyteFetchText({
    apiKey: args.providerKey,
    url: `${PUBLIC_SEARCH_URL}?${params}`,
    fetchImpl: args.doFetch,
  });
  return parseRedditSearchHtml(html).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    createdSec: Math.floor(r.publishedAt / 1000),
    author: r.author,
    subreddit: r.subreddit,
    url: r.url,
  }));
}

export const redditAdapter: SourceAdapter = {
  source: 'reddit',
  kind: 'per-term',
  async fetchSince({ cursor, term, fetchImpl, auth, providerKey, budget }) {
    if (!term) {
      throw new Error('reddit: per-term adapter called without a term');
    }
    if (!auth && !providerKey) {
      console.warn(`[sources:reddit] no credentials configured; deferring poll for "${term}"`);
      return { items: [], nextCursor: cursor };
    }
    const doFetch = fetchImpl ?? fetch;
    const sinceSec = cursor !== null ? Number.parseInt(cursor, 10) : 0;

    let posts: RedditPost[];
    if (auth) {
      // Official credentials are free and sanctioned: always preferred.
      posts = await fetchDirect({ auth, term, doFetch });
    } else {
      // Provider requests cost money, so they ride a monthly budget: one
      // request per poll, checked before spending and debited after.
      const remaining = budget ? await budget.remaining() : Number.POSITIVE_INFINITY;
      if (remaining <= 0) {
        console.warn(`[sources:reddit] monthly request budget exhausted; deferring "${term}"`);
        return { items: [], nextCursor: cursor };
      }
      posts = await fetchViaProvider({ providerKey: providerKey!, term, doFetch });
      if (budget) await budget.record(1);
    }

    let maxCreatedSec = 0;
    const candidates = posts.map((p): RawItem | null => {
      if (p.createdSec < sinceSec) return null;
      if (p.createdSec > maxCreatedSec) maxCreatedSec = p.createdSec;

      const text = clampText(
        [p.title.trim(), p.body.trim(), p.subreddit ? `r/${p.subreddit}` : '']
          .filter(Boolean)
          .join('\n\n'),
      );
      if (!text) return null;

      const author = p.author && p.author !== '[deleted]' ? p.author : undefined;
      return {
        source: 'reddit',
        externalId: `post:${p.id}`,
        url: p.url,
        text,
        // created_utc is a float; publishedAt must be an int (epoch ms).
        publishedAt: Math.round(p.createdSec * 1000),
        ...(author ? { author, authorUrl: `https://www.reddit.com/user/${author}` } : {}),
      };
    });

    const items = finalizeItems({ source: 'reddit', candidates });
    const nextCursor = maxCreatedSec > 0 ? String(Math.floor(maxCreatedSec)) : cursor;
    return { items, nextCursor };
  },
};
