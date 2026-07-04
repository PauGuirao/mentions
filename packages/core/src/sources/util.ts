/** Shared normalization helpers for source adapters. */
import { rawItemSchema, type RawItem, type Source } from '../schemas';

/** rawItemSchema documents an 8KB text cap enforced at ingest — this is it. */
export const MAX_TEXT_CHARS = 8192;

export function clampText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the HTML entities that actually show up in API payloads (HN Algolia
 *  and the Stack Exchange API both entity-encode text fields). */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = Number.parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, name: string) => NAMED_ENTITIES[name] ?? ' ');
}

/** Tag-strip + entity-decode + whitespace-collapse. For fields that carry
 *  actual HTML (HN story/comment bodies). Plain-text fields (titles, GitHub
 *  markdown) must NOT go through this — literal `<Foo>` in a title is text,
 *  not a tag. Use decodeEntities alone for entity-encoded plain text. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Final gate every adapter runs its mapped candidates through:
 * - null candidates (per-item mapping decided to skip) are dropped,
 * - each survivor is validated against rawItemSchema (a malformed item is
 *   skipped and counted, never thrown — one bad row must not sink a poll),
 * - result is sorted oldest-first, the ordering contract of fetchSince.
 */
export function finalizeItems({
  source,
  candidates,
}: {
  source: Source;
  candidates: ReadonlyArray<RawItem | null>;
}): RawItem[] {
  const items: RawItem[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate === null) {
      skipped++;
      continue;
    }
    const parsed = rawItemSchema.safeParse(candidate);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.warn(`[sources:${source}] skipped ${skipped} malformed item(s)`);
  }
  items.sort((a, b) => a.publishedAt - b.publishedAt);
  return items;
}
