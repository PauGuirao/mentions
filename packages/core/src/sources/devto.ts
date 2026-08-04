/**
 * DEV Community via the public Forem API (https://developers.forem.com/api),
 * /articles/latest. No auth needed for public articles. Global adapter: one
 * poll covers all new articles.
 *
 * Cursor: epoch MILLISECONDS of the newest ingested article's
 * `published_timestamp`, as a string. /articles/latest is newest-first and
 * page-based, so we paginate until a page reaches items at/before the cursor
 * (inclusive compare + downstream dedupe, same policy as the other sources),
 * capped at MAX_PAGES as a runaway guard. First poll looks back 1 hour.
 *
 * Quirks:
 * - `tag_list` is inconsistent across Forem endpoints: an ARRAY on list
 *   endpoints but a comma-joined STRING on the single-article endpoint. We
 *   accept both shapes defensively.
 * - `description` can be null/empty for very short posts.
 */
import { z } from 'zod';
import type { RawItem } from '../schemas';
import type { SourceAdapter } from './types';
import { clampText, finalizeItems, ADAPTER_HEADERS } from './util';

const BOOTSTRAP_LOOKBACK_MS = 3_600_000;
/**
 * DO NOT RAISE TO 100. dev.to fronts this endpoint with a CDN, and the
 * `per_page=100` variant of page 1 is served from a long-lived cache entry —
 * measured 2026-08-04 at `age: 46240` (12.8 hours) with `x-cache: HIT, HIT`,
 * while `per_page=2` and `per_page=30` both returned `age: 0`. A cache-buster
 * query param does not help; `_` is not part of their cache key.
 *
 * That stale page 1 DEADLOCKS this adapter. Its newest article freezes at
 * whatever the cursor was when the entry was cached, so every poll sees
 * nothing newer, hits `sawOlder`, breaks before reaching pages 2+ (which are
 * fresh, and can even be NEWER than page 1), and never advances the cursor.
 * Observed in production: devto stopped ingesting for ~20h while still being
 * scheduled and returning HTTP 200.
 */
const PER_PAGE = 30;
/** dev.to publishes ~330 articles/hour (measured: 150 articles spanned 27
 *  minutes). At PER_PAGE=30 an hourly cadence needs ~11 pages, so this is
 *  that plus headroom. The loop still exits early at the cursor, so a quiet
 *  hour costs one request, not fifteen. */
const MAX_PAGES = 15;

const devtoArticleSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullish(),
  url: z.string().url(),
  published_timestamp: z.string(),
  tag_list: z.union([z.array(z.string()), z.string()]).optional(),
  user: z.object({ username: z.string().optional(), name: z.string().optional() }).nullish(),
});

const devtoPageSchema = z.array(z.unknown());

function tagsOf(tagList: string[] | string | undefined): string[] {
  if (tagList === undefined) return [];
  const list = Array.isArray(tagList) ? tagList : tagList.split(',');
  return list.map((t) => t.trim()).filter(Boolean);
}

export const devtoAdapter: SourceAdapter = {
  source: 'devto',
  kind: 'global',
  async fetchSince({ cursor, fetchImpl }) {
    const doFetch = fetchImpl ?? fetch;
    const sinceMs = cursor !== null ? Number.parseInt(cursor, 10) : Date.now() - BOOTSTRAP_LOOKBACK_MS;

    const candidates: Array<RawItem | null> = [];
    let newestMs = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await doFetch(
        `https://dev.to/api/articles/latest?page=${page}&per_page=${PER_PAGE}`,
        { headers: ADAPTER_HEADERS },
      );
      if (!res.ok) {
        throw new Error(`devto: articles/latest responded ${res.status}`);
      }
      const entries = devtoPageSchema.parse(await res.json());

      let sawOlder = false;
      for (const raw of entries) {
        const parsed = devtoArticleSchema.safeParse(raw);
        if (!parsed.success) {
          candidates.push(null); // counted as skipped by finalizeItems
          continue;
        }
        const a = parsed.data;
        const publishedMs = Date.parse(a.published_timestamp);
        if (Number.isNaN(publishedMs)) {
          candidates.push(null);
          continue;
        }
        if (publishedMs < sinceMs) {
          sawOlder = true;
          continue;
        }
        if (publishedMs > newestMs) newestMs = publishedMs;

        const tags = tagsOf(a.tag_list).map((t) => `#${t}`);
        const text = clampText(
          [a.title.trim(), a.description?.trim() ?? '', tags.join(' ')].filter(Boolean).join('\n\n'),
        );
        if (!text) {
          candidates.push(null);
          continue;
        }
        candidates.push({
          source: 'devto',
          externalId: String(a.id),
          url: a.url,
          text,
          publishedAt: publishedMs,
          ...(a.user?.username
            ? { author: a.user.name ?? a.user.username, authorUrl: `https://dev.to/${a.user.username}` }
            : {}),
        });
      }

      // Stop once this page reached content at/before the cursor, or the feed
      // ran out (short page).
      if (sawOlder || entries.length < PER_PAGE) break;
    }

    const items = finalizeItems({ source: 'devto', candidates });
    const nextCursor = newestMs > 0 ? String(newestMs) : (cursor ?? String(sinceMs));
    return { items, nextCursor };
  },
};
