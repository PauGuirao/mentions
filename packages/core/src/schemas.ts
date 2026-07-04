/**
 * Single source of truth for every shape in the product: API bodies/responses,
 * queue messages, and MCP tool inputs all derive from these zod schemas.
 * Infer types from here — never re-declare a parallel interface.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const SOURCES = ['bluesky', 'hackernews', 'github', 'stackoverflow', 'devto'] as const;
export const sourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof sourceSchema>;

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/** Normalized item every source adapter emits; the matcher's only input. */
export const rawItemSchema = z.object({
  source: sourceSchema,
  externalId: z.string().min(1),
  url: z.string().url(),
  author: z.string().optional(),
  authorUrl: z.string().url().optional(),
  /** Full searchable text (title + body/comment). Truncated to 8KB at ingest. */
  text: z.string().min(1),
  /** Epoch ms. */
  publishedAt: z.number().int().positive(),
});
export type RawItem = z.infer<typeof rawItemSchema>;

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

export const keywordKindSchema = z.enum(['brand', 'competitor', 'topic']);

export const createKeywordBodySchema = z.object({
  term: z.string().min(2).max(80),
  kind: keywordKindSchema.default('brand'),
});

export const keywordSchema = z.object({
  id: z.string(),
  term: z.string(),
  kind: keywordKindSchema,
  muted: z.boolean(),
  createdAt: z.number(),
});
export type Keyword = z.infer<typeof keywordSchema>;

// ---------------------------------------------------------------------------
// Mentions (the tenant-facing read model = mention_matches joined to mentions)
// ---------------------------------------------------------------------------

export const sentimentSchema = z.enum(['positive', 'neutral', 'negative']);
export const matchStateSchema = z.enum([
  'matched',
  'classified',
  'filtered',
  'delivered',
  'ignored',
  'done',
]);

export const mentionSchema = z.object({
  id: z.string(), // mention_match id — the tenant-scoped identity
  source: sourceSchema,
  url: z.string(),
  author: z.string().nullable(),
  authorUrl: z.string().nullable(),
  text: z.string(),
  publishedAt: z.number(),
  keywordId: z.string(),
  keywordTerm: z.string(),
  state: matchStateSchema,
  relevance: z.number().int().min(0).max(100).nullable(),
  sentiment: sentimentSchema.nullable(),
  intents: z.array(z.string()),
  aiNote: z.string().nullable(),
  createdAt: z.number(),
});
export type Mention = z.infer<typeof mentionSchema>;

export const searchMentionsQuerySchema = z.object({
  keywordId: z.string().optional(),
  source: sourceSchema.optional(),
  state: matchStateSchema.optional(),
  minRelevance: z.coerce.number().int().min(0).max(100).optional(),
  sentiment: sentimentSchema.optional(),
  intent: z.string().optional(),
  q: z.string().optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type SearchMentionsQuery = z.infer<typeof searchMentionsQuerySchema>;

// ---------------------------------------------------------------------------
// Feeds & destinations
// ---------------------------------------------------------------------------

export const feedFilterSchema = z.object({
  keywordIds: z.array(z.string()).optional(),
  sources: z.array(sourceSchema).optional(),
  minRelevance: z.number().int().min(0).max(100).optional(),
  sentiments: z.array(sentimentSchema).optional(),
  intents: z.array(z.string()).optional(),
});
export type FeedFilter = z.infer<typeof feedFilterSchema>;

export const createFeedBodySchema = z.object({
  name: z.string().min(1).max(80),
  filter: feedFilterSchema,
});

export const destinationConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webhook'), url: z.string().url(), secret: z.string().min(16) }),
  z.object({ type: z.literal('slack'), botToken: z.string().min(1), channel: z.string().min(1) }),
]);

// ---------------------------------------------------------------------------
// Company context
// ---------------------------------------------------------------------------

export const companyContextBodySchema = z.object({
  /** What the company does, products, competitors — fed verbatim to the
   *  classifier. The single biggest relevance lever. */
  context: z.string().max(4000),
});

// ---------------------------------------------------------------------------
// Classification output (LLM contract)
// ---------------------------------------------------------------------------

export const classificationSchema = z.object({
  relevance: z.number().int().min(0).max(100),
  sentiment: sentimentSchema,
  intents: z.array(z.enum(['buy_intent', 'question', 'complaint', 'praise', 'comparison'])),
  note: z.string().max(200),
});
export type Classification = z.infer<typeof classificationSchema>;
