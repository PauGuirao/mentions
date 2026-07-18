/**
 * News/blog coverage via the GDELT DOC 2.0 API
 * (https://api.gdeltproject.org/api/v2/doc/doc, artlist mode), polled per
 * normalized term. Free, keyless, and — unlike Google News RSS, whose feed
 * terms are personal/non-commercial only — open for commercial use, which is
 * why this transport replaced the RSS one. Per CLAUDE.md invariant 5 the
 * swap is invisible outside this file; the cursor unit (epoch ms) is
 * unchanged on purpose so cursors stored by the previous transport survive.
 *
 * Cursor: epoch MILLISECONDS of the newest ingested article's `seendate`
 * (when GDELT's crawler saw it — monotonic with crawl time, which suits a
 * cursor better than publish time). Passed back as `startdatetime`
 * (YYYYMMDDHHMMSS UTC); boundary behavior is undocumented so we assume
 * inclusive — refetched boundary articles dedupe downstream. First poll
 * looks back 24 hours. GDELT indexes 65 languages and we deliberately do NOT
 * filter language: brand terms are language-independent and global coverage
 * is a feature.
 *
 * Quirks (verified live 2026-07-04):
 * - RATE LIMIT: one request per ~5s per IP, answered with a plain-text 429.
 *   Workers share egress IPs, so occasional 429s are expected noise: we
 *   throw, ingest retries at >=30s (clear of the window), and a dropped poll
 *   self-heals because the cursor never advanced. The 30-min cadence plus
 *   slot-hashing keeps our own request rate far below the limit.
 * - Malformed-query errors arrive as HTTP 200 with a PLAIN TEXT body, so a
 *   JSON.parse failure throws loudly instead of reading as an empty poll.
 * - Zero matches: the `articles` key is absent (sometimes an empty body).
 * - `seendate` is compact ("20260702T083000Z") — Date.parse can't read it,
 *   so it's reshaped to ISO first, strictly (a non-matching shape is
 *   rejected, never guessed at).
 * - Articles carry no id, so externalId is the article URL itself.
 * - Titles occasionally carry HTML entities; decodeEntities is harmless
 *   when they don't.
 */
import { z } from 'zod';
import type { RawItem } from '../schemas';
import type { SourceAdapter } from './types';
import { clampText, decodeEntities, finalizeItems, ADAPTER_HEADERS } from './util';

const SEARCH_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const BOOTSTRAP_LOOKBACK_MS = 86_400_000;
/** API maximum for artlist mode. */
const MAX_RECORDS = 250;

const gdeltArticleSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  seendate: z.string(),
  domain: z.string().optional(),
});

const gdeltResponseSchema = z.object({ articles: z.array(z.unknown()).optional() });

/** "20260702T083000Z" -> epoch ms; NaN when the shape doesn't match. */
function parseSeenDate(seendate: string): number {
  const m = seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return Number.NaN;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

/** Epoch ms -> GDELT's YYYYMMDDHHMMSS (UTC). */
function toGdeltDatetime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export const newsAdapter: SourceAdapter = {
  source: 'news',
  kind: 'per-term',
  async fetchSince({ cursor, term, fetchImpl }) {
    if (!term) {
      throw new Error('news: per-term adapter called without a term');
    }
    const doFetch = fetchImpl ?? fetch;
    const sinceMs = cursor !== null ? Number.parseInt(cursor, 10) : Date.now() - BOOTSTRAP_LOOKBACK_MS;

    // Quote the term for phrase matching; embedded quotes would break the
    // query syntax, so drop them (same policy as the github adapter).
    const phrase = term.replace(/"/g, '');
    const params = new URLSearchParams({
      query: `"${phrase}"`,
      mode: 'artlist',
      format: 'json',
      sort: 'datedesc',
      maxrecords: String(MAX_RECORDS),
      startdatetime: toGdeltDatetime(sinceMs),
    });
    const res = await doFetch(`${SEARCH_URL}?${params}`, { headers: ADAPTER_HEADERS });
    if (!res.ok) {
      // Usually the shared-egress 429; ingest's >=30s retry clears it.
      throw new Error(`news: GDELT responded ${res.status}`);
    }
    const raw = await res.text();
    if (raw.trim() === '') {
      return { items: [], nextCursor: cursor };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`news: GDELT returned a non-JSON body: ${raw.slice(0, 120)}`);
    }
    const body = gdeltResponseSchema.parse(payload);

    let newestMs = 0;
    const candidates = (body.articles ?? []).map((rawArticle): RawItem | null => {
      const parsed = gdeltArticleSchema.safeParse(rawArticle);
      if (!parsed.success) return null;
      const a = parsed.data;
      const seenMs = parseSeenDate(a.seendate);
      if (Number.isNaN(seenMs)) return null;
      if (seenMs > newestMs) newestMs = seenMs;

      const headline = decodeEntities(a.title).trim();
      const text = clampText([headline, a.domain ?? ''].filter(Boolean).join('\n\n'));
      if (!text) return null;

      return {
        source: 'news',
        externalId: `article:${a.url}`,
        url: a.url,
        text,
        publishedAt: seenMs,
        ...(a.domain ? { author: a.domain, authorUrl: `https://${a.domain}` } : {}),
      };
    });

    const items = finalizeItems({ source: 'news', candidates });
    const nextCursor = newestMs > 0 ? String(newestMs) : cursor;
    return { items, nextCursor };
  },
};
