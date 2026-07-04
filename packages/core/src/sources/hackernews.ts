/**
 * Hacker News via the Algolia HN Search API (https://hn.algolia.com/api).
 * No auth, no key. Global adapter: one search_by_date poll covers every
 * story + comment on the site; the matcher fans results out to terms.
 *
 * Cursor: `created_at_i` (epoch SECONDS) of the newest ingested item, as a
 * string. Queries filter with `created_at_i>=cursor` — inclusive, so items
 * sharing the boundary second are never lost; the refetched duplicate is
 * deduped downstream on (source, externalId).
 *
 * Quirks:
 * - search_by_date returns hits newest-first; we re-sort oldest-first.
 * - Text fields (story_text, comment_text) are HTML with entities encoded
 *   (e.g. `&#x27;`, `<p>`); titles are plain text and must NOT be tag-stripped.
 * - `tags=(story,comment)` is Algolia's OR syntax.
 */
import { z } from 'zod';
import type { RawItem } from '../schemas';
import type { SourceAdapter } from './types';
import { clampText, finalizeItems, stripHtml } from './util';

/** First ever poll looks back 10 minutes instead of backfilling all of HN. */
const BOOTSTRAP_LOOKBACK_SEC = 600;
/** Comfortably above HN's real story+comment rate for a 60s cadence. */
const HITS_PER_PAGE = 200;

const hnHitSchema = z.object({
  objectID: z.string().min(1),
  created_at_i: z.number().int().positive(),
  author: z.string().nullish(),
  title: z.string().nullish(),
  story_text: z.string().nullish(),
  comment_text: z.string().nullish(),
});

const hnResponseSchema = z.object({ hits: z.array(z.unknown()) });

export const hackernewsAdapter: SourceAdapter = {
  source: 'hackernews',
  kind: 'global',
  async fetchSince({ cursor, fetchImpl }) {
    const doFetch = fetchImpl ?? fetch;
    const since =
      cursor !== null
        ? Number.parseInt(cursor, 10)
        : Math.floor(Date.now() / 1000) - BOOTSTRAP_LOOKBACK_SEC;

    const params = new URLSearchParams({
      tags: '(story,comment)',
      hitsPerPage: String(HITS_PER_PAGE),
      numericFilters: `created_at_i>=${since}`,
    });
    const res = await doFetch(`https://hn.algolia.com/api/v1/search_by_date?${params}`);
    if (!res.ok) {
      throw new Error(`hackernews: Algolia responded ${res.status}`);
    }
    const body = hnResponseSchema.parse(await res.json());

    let maxCreatedSec = 0;
    const candidates = body.hits.map((raw): RawItem | null => {
      const hit = hnHitSchema.safeParse(raw);
      if (!hit.success) return null;
      const h = hit.data;

      const parts: string[] = [];
      if (h.title) parts.push(h.title.trim());
      const htmlBody = h.comment_text ?? h.story_text;
      if (htmlBody) parts.push(stripHtml(htmlBody));
      const text = clampText(parts.filter(Boolean).join('\n\n'));
      if (!text) return null;

      if (h.created_at_i > maxCreatedSec) maxCreatedSec = h.created_at_i;
      return {
        source: 'hackernews',
        externalId: h.objectID,
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        text,
        publishedAt: h.created_at_i * 1000,
        ...(h.author
          ? { author: h.author, authorUrl: `https://news.ycombinator.com/user?id=${h.author}` }
          : {}),
      };
    });

    const items = finalizeItems({ source: 'hackernews', candidates });
    const nextCursor = maxCreatedSec > 0 ? String(maxCreatedSec) : (cursor ?? String(since));
    return { items, nextCursor };
  },
};
