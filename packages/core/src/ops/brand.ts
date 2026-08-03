/**
 * Onboarding brand analysis: turn a user's website into a brand profile and
 * starter keyword suggestions. The prompt build / response parse / HTML
 * extraction helpers are pure (unit-tested, no bindings); the API worker owns
 * the fetch and the AI call, and completeOnboarding owns the D1 writes.
 * Mirrors the classifier's prompt+parse pattern (workers/classifier/classify.ts).
 */
import { brandAnalysisSchema, type BrandAnalysis } from '../schemas';
import { DuplicateKeywordError, KeywordLimitError, createKeyword } from './keywords';

/** The one place the onboarding model id lives (same family as the classifier). */
export const BRAND_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const MAX_SITE_CHARS = 8000;
const MAX_CONTEXT_CHARS = brandAnalysisSchema.shape.context.maxLength ?? 4000;

const SYSTEM_PROMPT = [
  'You are the onboarding assistant of a social listening tool for developer-facing companies.',
  'You are given the homepage text of a company website. Build a brand profile for tracking mentions of this company across social platforms.',
  '',
  'Respond with ONLY a single JSON object, no markdown fences, no prose, exactly this shape:',
  `{"brandName": "<the company or product name>", "context": "<one paragraph, max ${MAX_CONTEXT_CHARS} chars: what the company does, its product, market, target audience and known competitors>", "topics": ["<term 1>", "<term 2>"], "competitors": ["<competitor 1>", "<competitor 2>"]}`,
  '',
  'Rules:',
  '- brandName is the short name people use when talking about the company, not a legal entity name.',
  '- context is fed to a relevance classifier; make it factual and specific, no marketing fluff.',
  '- topics are exactly 2 short search terms for the space, activity or product category (e.g. "email api", "social listening"). Lowercase, 1-3 words each, never the brand name itself.',
  '- competitors are exactly 2 names of competing products or companies. If the site names none, infer the most likely ones from the market.',
].join('\n');

export function buildBrandAnalysisMessages(args: {
  website: string;
  pageText: string;
}): ChatMessage[] {
  const user = [
    `Website: ${args.website}`,
    '',
    'Homepage content:',
    '"""',
    args.pageText,
    '"""',
    '',
    'Build the brand profile. Reply with the JSON object only.',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Second-chance conversation after an unparseable first reply. */
export function buildBrandJsonRetryMessages(args: {
  messages: ChatMessage[];
  badReply: string;
}): ChatMessage[] {
  const nudge: ChatMessage = {
    role: 'user',
    content:
      'Your previous reply was not a valid JSON object. Return ONLY the JSON object described in the instructions. No markdown, no code fences, no explanations.',
  };
  if (args.badReply.trim() === '') {
    return [...args.messages, nudge];
  }
  return [...args.messages, { role: 'assistant', content: args.badReply }, nudge];
}

/** Extract the assistant text out of whatever shape env.AI.run returned
 *  (legacy { response } or an OpenAI-style chat.completion envelope). */
export function extractAiText(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (output === null || typeof output !== 'object') return null;

  if ('response' in output) {
    const response = (output as { response?: unknown }).response;
    if (typeof response === 'string') return response;
  }

  if ('choices' in output) {
    const choices = (output as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first: unknown = choices[0];
      if (first !== null && typeof first === 'object' && 'message' in first) {
        const message = (first as { message?: unknown }).message;
        if (message !== null && typeof message === 'object' && 'content' in message) {
          const content = (message as { content?: unknown }).content;
          if (typeof content === 'string') return content;
        }
      }
    }
  }

  return null;
}

const cleanTerms = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
        .map((t) => t.slice(0, 80))
        .slice(0, max)
    : [];

/**
 * Parse an LLM reply into a BrandAnalysis, or null when unusable. Forgiving
 * about packaging (fences, surrounding prose, over-long strings, extra array
 * entries) but strict about substance: a missing brand name or empty
 * topics/competitors fails the parse so the caller can retry with a nudge.
 */
export function parseBrandAnalysisResponse(raw: string): BrandAnalysis | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    brandName: typeof obj['brandName'] === 'string' ? obj['brandName'].trim().slice(0, 80) : obj['brandName'],
    context:
      typeof obj['context'] === 'string' ? obj['context'].trim().slice(0, MAX_CONTEXT_CHARS) : '',
    topics: cleanTerms(obj['topics'], 2),
    competitors: cleanTerms(obj['competitors'], 2),
  };

  const result = brandAnalysisSchema.safeParse(normalized);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Website HTML extraction (pure string work; the worker does the fetch)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = Number.parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, name: string) => NAMED_ENTITIES[name] ?? ' ');

const stripTags = (html: string): string =>
  decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const metaContent = (html: string, pattern: RegExp): string | null => {
  const tag = html.match(pattern)?.[0];
  const content = tag?.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content).trim() : null;
};

/** Reduce a fetched homepage to prompt text: title + meta description up
 *  front (the highest-signal lines), then the tag-stripped body, capped. */
export function extractSiteText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg\s*>/gi, ' ');

  const title = withoutBlocks.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const description =
    metaContent(withoutBlocks, /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i) ??
    metaContent(withoutBlocks, /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i);

  const parts: string[] = [];
  if (title) parts.push(`Title: ${stripTags(title)}`);
  if (description) parts.push(`Description: ${description}`);
  parts.push(stripTags(withoutBlocks));

  const text = parts.join('\n').trim();
  return text.length > MAX_SITE_CHARS ? text.slice(0, MAX_SITE_CHARS) : text;
}

/** First <link rel*="icon"> href resolved against the page URL, or null. */
export function extractFaviconUrl(html: string, baseUrl: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = tag.match(/rel\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!rel || !/\bicon\b/i.test(rel)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!href) continue;
    try {
      return new URL(decodeEntities(href), baseUrl).toString();
    } catch {
      continue;
    }
  }
  return null;
}

/** Fallback icon when the site declares none. */
export function googleFaviconUrl(website: string): string {
  const host = new URL(website).hostname;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/**
 * Validate a user-supplied website URL for server-side fetching: http(s)
 * only, and never a loopback/private/link-local target (the API worker
 * fetches this URL, so it must not be steerable at internal services).
 */
export function validateWebsiteUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (host.startsWith('[')) return null; // IPv6 literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return null;
    if (a === 192 && b === 168) return null;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return null;
    if (a === 169 && b === 254) return null;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Write the confirmed brand profile onto the org and create the starter
 * keywords. Duplicate terms (already-existing keywords or repeated
 * suggestions) are skipped, not errors.
 */
export async function completeOnboarding(args: {
  db: D1Database;
  orgId: string;
  website: string;
  brandName: string;
  logoUrl: string | null;
  context: string;
  keywords: Array<{ term: string; kind: 'brand' | 'competitor' | 'topic' }>;
}): Promise<{ keywordsCreated: number }> {
  const { db, orgId, website, brandName, logoUrl, context, keywords } = args;

  // The AI paragraph seeds both the structured profile description and the
  // flat classifier context (see ops/company.ts for how they relate).
  await db
    .prepare(
      'UPDATE orgs SET website = ?, brand_name = ?, logo_url = ?, description = ?, company_context = ?, onboarded_at = ? WHERE id = ?',
    )
    .bind(website, brandName, logoUrl, context, context, Date.now(), orgId)
    .run();

  let keywordsCreated = 0;
  for (const keyword of keywords) {
    try {
      await createKeyword({ db, orgId, term: keyword.term, kind: keyword.kind });
      keywordsCreated++;
    } catch (err) {
      // Plan capacity ends creation (keywordsCreated tells the client how
      // far we got); a duplicate just skips to the next suggestion.
      if (err instanceof KeywordLimitError) break;
      if (!(err instanceof DuplicateKeywordError)) throw err;
    }
  }
  return { keywordsCreated };
}
