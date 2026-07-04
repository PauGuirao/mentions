/**
 * X (Twitter) via API v2 recent search (GET /2/tweets/search/recent,
 * https://docs.x.com/x-api/posts/search/introduction), polled per normalized
 * term.
 *
 * DELIBERATELY COST-GATED: recent search only exists on paid tiers and reads
 * are metered per post, so this adapter spends real money. The guards (per
 * CLAUDE.md, budget guards live next to the adapter that spends them):
 * - No bearer token configured -> every poll DEFERS (warn + same cursor), so
 *   turning the source on is `wrangler secret put X_BEARER_TOKEN`, no deploy.
 * - A BudgetMeter (KV-backed monthly counter, built by createMonthlyReadMeter
 *   below and injected by the ingest worker) is consulted BEFORE the request
 *   and debited with the posts actually returned. Budget gone -> polls defer
 *   until the month rolls over.
 * - `max_results` shrinks toward the remaining budget (API floor is 10).
 * - Bootstrap looks back 1 hour, not the API's full 7 days.
 * - One page per poll: a >100-new-posts burst in one window is ceded to the
 *   budget, not chased with next_token.
 *
 * Cursor: id of the newest ingested post (snowflake ids are time-ordered),
 * passed back as `since_id` — which is EXCLUSIVE, so there is no boundary
 * refetch at all for this source.
 */
import { z } from 'zod';
import type { RawItem } from '../schemas';
import type { BudgetMeter, SourceAdapter } from './types';
import { clampText, finalizeItems } from './util';

const SEARCH_URL = 'https://api.x.com/2/tweets/search/recent';
const BOOTSTRAP_LOOKBACK_MS = 3_600_000;
const PAGE_MAX = 100;
/** The API rejects max_results below 10. */
const PAGE_MIN = 10;

/** Default monthly read cap; sized to the Basic tier's 10k posts/month with
 *  headroom for the meter's soft (last-write-wins) accounting. Override with
 *  the X_MONTHLY_READ_CAP var on the ingest worker. */
export const X_DEFAULT_MONTHLY_READ_CAP = 9_000;

const xTweetSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  created_at: z.string(),
  author_id: z.string().optional(),
});

const xUserSchema = z.object({
  id: z.string(),
  username: z.string().min(1),
  name: z.string().optional(),
});

const xResponseSchema = z.object({
  data: z.array(z.unknown()).optional(),
  includes: z.object({ users: z.array(z.unknown()).optional() }).optional(),
  meta: z.object({ newest_id: z.string().optional() }).optional(),
});

export const xAdapter: SourceAdapter = {
  source: 'x',
  kind: 'per-term',
  async fetchSince({ cursor, term, fetchImpl, auth, budget }) {
    if (!term) {
      throw new Error('x: per-term adapter called without a term');
    }
    if (!auth) {
      console.warn(`[sources:x] no bearer token configured; deferring poll for "${term}"`);
      return { items: [], nextCursor: cursor };
    }
    const remaining = budget ? await budget.remaining() : Number.POSITIVE_INFINITY;
    if (remaining <= 0) {
      console.warn(`[sources:x] monthly read budget exhausted; deferring poll for "${term}"`);
      return { items: [], nextCursor: cursor };
    }
    const doFetch = fetchImpl ?? fetch;

    // Quote the term for phrase matching; embedded quotes would break the
    // query syntax, so drop them (same policy as the github adapter).
    const phrase = term.replace(/"/g, '');
    const maxResults = Math.max(PAGE_MIN, Math.min(PAGE_MAX, Math.floor(remaining)));
    const params = new URLSearchParams({
      query: `"${phrase}" -is:retweet`,
      max_results: String(maxResults),
      'tweet.fields': 'created_at,author_id',
      expansions: 'author_id',
      'user.fields': 'username,name',
    });
    if (cursor !== null) {
      params.set('since_id', cursor);
    } else {
      // The API documents second granularity for timestamps — strip the ms.
      const startTime = new Date(Date.now() - BOOTSTRAP_LOOKBACK_MS).toISOString();
      params.set('start_time', startTime.replace(/\.\d{3}Z$/, 'Z'));
    }

    const res = await doFetch(`${SEARCH_URL}?${params}`, {
      headers: { Authorization: `Bearer ${auth}` },
    });
    if (!res.ok) {
      // 429 here is the request rate limit (not the read budget); throwing
      // lets the ingest worker retry with backoff.
      throw new Error(`x: recent search responded ${res.status}`);
    }
    const body = xResponseSchema.parse(await res.json());
    const data = body.data ?? [];
    if (budget && data.length > 0) {
      await budget.record(data.length);
    }

    const users = new Map<string, { username: string; name?: string }>();
    for (const raw of body.includes?.users ?? []) {
      const user = xUserSchema.safeParse(raw);
      if (user.success) users.set(user.data.id, user.data);
    }

    const candidates = data.map((raw): RawItem | null => {
      const parsed = xTweetSchema.safeParse(raw);
      if (!parsed.success) return null;
      const t = parsed.data;
      const publishedMs = Date.parse(t.created_at);
      if (Number.isNaN(publishedMs)) return null;
      const text = clampText(t.text.trim());
      if (!text) return null;

      const user = t.author_id !== undefined ? users.get(t.author_id) : undefined;
      return {
        source: 'x',
        externalId: `tweet:${t.id}`,
        // /i/web/status resolves without a username when the author expansion
        // is missing from the payload.
        url: user
          ? `https://x.com/${user.username}/status/${t.id}`
          : `https://x.com/i/web/status/${t.id}`,
        text,
        publishedAt: publishedMs,
        ...(user
          ? { author: user.name ?? user.username, authorUrl: `https://x.com/${user.username}` }
          : {}),
      };
    });

    const items = finalizeItems({ source: 'x', candidates });
    return { items, nextCursor: body.meta?.newest_id ?? cursor };
  },
};

/**
 * KV-backed BudgetMeter counting units per UTC calendar month under
 * `budget:<source>:<YYYY-MM>`. Soft accounting (see BudgetMeter) — the 40-day
 * TTL lets a key outlive its month for inspection, then self-clean.
 */
export function createMonthlyReadMeter(args: {
  kv: KVNamespace;
  source: string;
  cap: number;
}): BudgetMeter {
  const key = () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return `budget:${args.source}:${month}`;
  };
  return {
    async remaining() {
      const spent = Number((await args.kv.get(key())) ?? '0');
      return args.cap - (Number.isFinite(spent) ? spent : args.cap);
    },
    async record(units) {
      if (units <= 0) return;
      const k = key();
      const spent = Number((await args.kv.get(k)) ?? '0');
      await args.kv.put(k, String((Number.isFinite(spent) ? spent : 0) + units), {
        expirationTtl: 40 * 86_400,
      });
    },
  };
}
