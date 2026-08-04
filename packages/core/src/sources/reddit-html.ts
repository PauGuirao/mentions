/**
 * Parser for old.reddit.com search result HTML.
 *
 * WHY HTML: Reddit blocks its JSON endpoints (`/search.json`, `/<post>.json`)
 * even through a residential scrape provider — verified 2026-08, they return
 * a hard ban while the HTML pages serve fine. old.reddit is the parse target
 * rather than www because it is server-rendered, an order of magnitude
 * smaller, and its markup has been stable for a decade (www is shreddit web
 * components that change with every redesign).
 *
 * Deliberately regex/string based rather than HTMLRewriter: HTMLRewriter only
 * exists in the Workers runtime, and these functions must stay unit-testable
 * in plain Node. The markup is machine-generated and uniform, so targeted
 * extraction is safe here in a way it would not be on hand-written pages.
 *
 * Everything here is PURE: no fetch, no bindings. The adapter owns transport.
 */

/** One post parsed out of the search listing. */
export interface RedditSearchResult {
  /** Base-36 post id, without the t3_ prefix. */
  id: string;
  title: string;
  /** Absolute www.reddit.com permalink. */
  url: string;
  /** Epoch ms. */
  publishedAt: number;
  author: string | null;
  subreddit: string | null;
  /** Self-post text, empty for link posts. */
  body: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Reddit HTML-escapes text nodes and uses numeric entities liberally
 *  (&#32; as a word separator, &#39; for apostrophes). */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

/** Strip tags, decode entities, collapse whitespace. Block-level tags become
 *  newlines so paragraphs do not run together into one word. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const first = (html: string, pattern: RegExp): string | null => {
  const match = pattern.exec(html);
  return match?.[1] ?? null;
};

/** Split the page into per-result chunks. Search pages contain a subreddit
 *  group as well as the posts group; only `search-result-link` blocks (whose
 *  data-fullname is a t3_ id) are posts. */
function resultChunks(html: string): string[] {
  const chunks: string[] = [];
  const opener = /<div class="[^"]*\bsearch-result-link\b[^"]*"[^>]*>/g;
  let match = opener.exec(html);
  while (match !== null) {
    const start = match.index;
    const next = opener.exec(html);
    chunks.push(html.slice(start, next?.index ?? html.length));
    match = next;
  }
  return chunks;
}

/**
 * Extract every post from an old.reddit search results page. Malformed or
 * unexpected blocks are skipped rather than throwing: a Reddit markup tweak
 * should degrade the harvest, never break the poll.
 */
export function parseRedditSearchHtml(html: string): RedditSearchResult[] {
  const results: RedditSearchResult[] = [];

  for (const chunk of resultChunks(html)) {
    const id = first(chunk, /data-fullname="t3_([a-z0-9]+)"/i);
    if (!id) continue;

    const titleAnchor = /<a[^>]*class="[^"]*\bsearch-title\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
      chunk,
    );
    if (!titleAnchor) continue;
    const title = htmlToText(titleAnchor[1] ?? '');
    if (!title) continue;

    const href = first(titleAnchor[0], /href="([^"]+)"/i);
    const isoDate = first(chunk, /<time[^>]*datetime="([^"]+)"/i);
    const publishedAt = isoDate ? Date.parse(decodeEntities(isoDate)) : Number.NaN;
    if (!Number.isFinite(publishedAt)) continue;

    const author = first(chunk, /<a[^>]*class="author[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const subreddit = first(
      chunk,
      /<a[^>]*class="[^"]*\bsearch-subreddit-link\b[^"]*"[^>]*>\s*r\/([^<]+)<\/a>/i,
    );
    const bodyHtml = first(
      chunk,
      /<div class="search-result-body">([\s\S]*?)<\/div>\s*<\/div>/i,
    );

    results.push({
      id,
      title,
      // Always hand downstream a canonical www permalink, whatever host the
      // listing linked to.
      url: href
        ? decodeEntities(href).replace(/^https?:\/\/(old|new)\.reddit\.com/i, 'https://www.reddit.com')
        : `https://www.reddit.com/comments/${id}`,
      publishedAt,
      author: author ? htmlToText(author) || null : null,
      subreddit: subreddit ? decodeEntities(subreddit).trim() : null,
      body: bodyHtml ? htmlToText(bodyHtml) : '',
    });
  }

  return results;
}
