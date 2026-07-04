/**
 * GitHub issue/PR search (https://api.github.com/search/issues), polled
 * per normalized term.
 *
 * Cursor: ISO-8601 `created_at` of the newest ingested item. The search API
 * has no "since" parameter, so we fetch the newest page (sort=created desc)
 * and filter client-side with an INCLUSIVE (>=) compare; the boundary item
 * gets refetched next poll and deduped downstream. First poll (null cursor)
 * takes the newest page as a bounded bootstrap.
 *
 * Quirks (from the REST docs):
 * - /search/issues returns BOTH issues and PRs (PRs carry a `pull_request`
 *   key). Both are useful mentions and `id` is unique across the two, so we
 *   keep both under `issue:<id>`.
 * - A User-Agent header is MANDATORY; GitHub 403s requests without one.
 * - Since 2025-09-04 the endpoint requires `advanced_search=true` (the legacy
 *   issue search was retired), so we always send it.
 * - Unauthenticated search is 10 req/min; with a token it's 30 req/min. The
 *   ingest worker passes GITHUB_TOKEN as `auth` when configured.
 * - `body` is null for empty issue descriptions.
 */
import { z } from 'zod';
import type { RawItem } from '../schemas';
import type { SourceAdapter } from './types';
import { clampText, finalizeItems } from './util';

const PER_PAGE = 50;

const githubIssueSchema = z.object({
  id: z.number().int(),
  html_url: z.string().url(),
  title: z.string(),
  body: z.string().nullish(),
  created_at: z.string(),
  user: z.object({ login: z.string(), html_url: z.string().url() }).nullish(),
});

const githubResponseSchema = z.object({ items: z.array(z.unknown()) });

export const githubAdapter: SourceAdapter = {
  source: 'github',
  kind: 'per-term',
  async fetchSince({ cursor, term, fetchImpl, auth }) {
    if (!term) {
      throw new Error('github: per-term adapter called without a term');
    }
    const doFetch = fetchImpl ?? fetch;
    const sinceMs = cursor !== null ? Date.parse(cursor) : 0;

    // Quote the term for phrase matching; embedded quotes would break the
    // search qualifier syntax, so drop them (normalizeTerm keeps them).
    const phrase = term.replace(/"/g, '');
    const params = new URLSearchParams({
      q: `"${phrase}" in:title,body`,
      sort: 'created',
      order: 'desc',
      per_page: String(PER_PAGE),
      advanced_search: 'true',
    });
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'mentions-ingest',
      'x-github-api-version': '2022-11-28',
    };
    if (auth) headers.authorization = `Bearer ${auth}`;

    const res = await doFetch(`https://api.github.com/search/issues?${params}`, { headers });
    if (!res.ok) {
      // 403/429 here is a rate limit; throwing lets the ingest worker retry.
      throw new Error(`github: search responded ${res.status}`);
    }
    const body = githubResponseSchema.parse(await res.json());

    let newestMs = 0;
    let newestIso: string | null = null;
    const candidates = body.items.map((raw): RawItem | null => {
      const issue = githubIssueSchema.safeParse(raw);
      if (!issue.success) return null;
      const it = issue.data;
      const createdMs = Date.parse(it.created_at);
      if (Number.isNaN(createdMs) || createdMs < sinceMs) return null;

      if (createdMs > newestMs) {
        newestMs = createdMs;
        newestIso = it.created_at;
      }
      const text = clampText([it.title.trim(), it.body?.trim() ?? ''].filter(Boolean).join('\n\n'));
      if (!text) return null;
      return {
        source: 'github',
        externalId: `issue:${it.id}`,
        url: it.html_url,
        text,
        publishedAt: createdMs,
        ...(it.user ? { author: it.user.login, authorUrl: it.user.html_url } : {}),
      };
    });

    const items = finalizeItems({ source: 'github', candidates });
    return { items, nextCursor: newestIso ?? cursor };
  },
};
