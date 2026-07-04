/**
 * Stack Overflow via the Stack Exchange API 2.3 /search/excerpts
 * (https://api.stackexchange.com/docs/excerpt-search), polled per term.
 *
 * Cursor: `creation_date` (epoch SECONDS) of the newest ingested item, as a
 * string. Passed back as `fromdate` — which is INCLUSIVE per the SE docs, so
 * boundary items refetch and dedupe downstream instead of getting lost.
 * First poll (null cursor) bootstraps with a 7-day lookback (SO volume per
 * term is low and the cadence is daily, so a little history is useful).
 *
 * Quirks (from the SE API docs):
 * - Every response carries `quota_remaining` (300/day per IP without a key,
 *   10k with one). When it drops below 10 we return EARLY with the SAME
 *   cursor and no items — the un-advanced cursor re-covers the window on the
 *   next scheduled poll after the daily quota reset. Deferral, not loss.
 * - Text fields (title, excerpt, owner.display_name) are HTML-entity encoded.
 * - Excerpt hits are `question` or `answer` (`item_type`); answers carry the
 *   parent question's title and their own `answer_id`.
 * - `backoff` (seconds) can appear on any response; with a per-term cadence
 *   of a day we just log it — the next call is far outside any backoff.
 * - An optional API key can be passed via `auth` (sent as `key=`).
 */
import { z } from 'zod';
import type { RawItem } from '../schemas';
import type { SourceAdapter } from './types';
import { clampText, decodeEntities, finalizeItems } from './util';

const BOOTSTRAP_LOOKBACK_SEC = 7 * 86_400;
const MIN_QUOTA = 10;
const PAGE_SIZE = 100;

const seItemSchema = z.object({
  item_type: z.enum(['question', 'answer']),
  question_id: z.number().int(),
  answer_id: z.number().int().optional(),
  title: z.string(),
  excerpt: z.string().optional(),
  creation_date: z.number().int().positive(),
  owner: z.object({ display_name: z.string().optional(), link: z.string().optional() }).optional(),
});

const seResponseSchema = z.object({
  items: z.array(z.unknown()),
  quota_remaining: z.number(),
  backoff: z.number().optional(),
  error_id: z.number().optional(),
  error_message: z.string().optional(),
});

export const stackoverflowAdapter: SourceAdapter = {
  source: 'stackoverflow',
  kind: 'per-term',
  async fetchSince({ cursor, term, fetchImpl, auth }) {
    if (!term) {
      throw new Error('stackoverflow: per-term adapter called without a term');
    }
    const doFetch = fetchImpl ?? fetch;
    const fromdate =
      cursor !== null
        ? Number.parseInt(cursor, 10)
        : Math.floor(Date.now() / 1000) - BOOTSTRAP_LOOKBACK_SEC;

    const params = new URLSearchParams({
      q: term,
      site: 'stackoverflow',
      sort: 'creation',
      order: 'asc',
      pagesize: String(PAGE_SIZE),
      fromdate: String(fromdate),
    });
    if (auth) params.set('key', auth);

    const res = await doFetch(`https://api.stackexchange.com/2.3/search/excerpts?${params}`);
    if (!res.ok) {
      throw new Error(`stackoverflow: SE API responded ${res.status}`);
    }
    const body = seResponseSchema.parse(await res.json());
    if (body.error_id !== undefined) {
      throw new Error(`stackoverflow: SE API error ${body.error_id}: ${body.error_message ?? ''}`);
    }
    if (body.backoff !== undefined) {
      console.warn(`[sources:stackoverflow] SE API asked for ${body.backoff}s backoff`);
    }
    if (body.quota_remaining < MIN_QUOTA) {
      // Preserve the remaining quota for other terms; same cursor means this
      // window is simply re-fetched after the daily quota reset.
      console.warn(
        `[sources:stackoverflow] quota_remaining=${body.quota_remaining} < ${MIN_QUOTA}; deferring poll for "${term}"`,
      );
      return { items: [], nextCursor: cursor };
    }

    let maxCreatedSec = 0;
    const candidates = body.items.map((raw): RawItem | null => {
      const parsed = seItemSchema.safeParse(raw);
      if (!parsed.success) return null;
      const it = parsed.data;

      const isAnswer = it.item_type === 'answer';
      if (isAnswer && it.answer_id === undefined) return null;
      const text = clampText(
        [decodeEntities(it.title).trim(), it.excerpt ? decodeEntities(it.excerpt).trim() : '']
          .filter(Boolean)
          .join('\n\n'),
      );
      if (!text) return null;

      if (it.creation_date > maxCreatedSec) maxCreatedSec = it.creation_date;
      const author = it.owner?.display_name ? decodeEntities(it.owner.display_name) : undefined;
      return {
        source: 'stackoverflow',
        externalId: isAnswer ? `answer:${it.answer_id}` : `question:${it.question_id}`,
        url: isAnswer
          ? `https://stackoverflow.com/a/${it.answer_id}`
          : `https://stackoverflow.com/questions/${it.question_id}`,
        text,
        publishedAt: it.creation_date * 1000,
        ...(author ? { author } : {}),
        ...(it.owner?.link ? { authorUrl: it.owner.link } : {}),
      };
    });

    const items = finalizeItems({ source: 'stackoverflow', candidates });
    const nextCursor = maxCreatedSec > 0 ? String(maxCreatedSec) : cursor;
    return { items, nextCursor };
  },
};
