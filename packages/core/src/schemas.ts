/**
 * Single source of truth for every shape in the product: API bodies/responses,
 * queue messages, and MCP tool inputs all derive from these zod schemas.
 * Infer types from here — never re-declare a parallel interface.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const SOURCES = [
  'bluesky',
  'hackernews',
  'github',
  'stackoverflow',
  'devto',
  'reddit',
  'x',
  'youtube',
  'news',
] as const;
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

export const mentionStatsQuerySchema = z.object({
  sinceDays: z.coerce.number().int().min(1).max(90).default(14),
  source: sourceSchema.optional(),
  keywordId: z.string().optional(),
});

const statCount = z.number().int().min(0);
export const mentionStatsSchema = z.object({
  sinceDays: z.number().int(),
  total: statCount,
  bySentiment: z.object({
    positive: statCount,
    neutral: statCount,
    negative: statCount,
    unclassified: statCount,
  }),
  bySource: z.array(z.object({ source: sourceSchema, count: statCount })),
  byKeyword: z.array(z.object({ keywordId: z.string(), term: z.string(), count: statCount })),
  /** One entry per day in the window, oldest first, zero-filled. */
  daily: z.array(
    z.object({
      day: z.string(), // YYYY-MM-DD (UTC)
      positive: statCount,
      neutral: statCount,
      negative: statCount,
      unclassified: statCount,
    }),
  ),
});
export type MentionStats = z.infer<typeof mentionStatsSchema>;

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
// Slack integration (OAuth install + managed notifications)
// ---------------------------------------------------------------------------

export const slackStatusSchema = z.object({
  /** Whether this deployment has Slack OAuth credentials at all. */
  configured: z.boolean(),
  connected: z.boolean(),
  teamName: z.string().nullable(),
  /** The managed notification config; null until a channel is picked. */
  notifications: z
    .object({
      channelId: z.string(),
      channelName: z.string(),
      minRelevance: z.number().int().min(0).max(100).nullable(),
      /** Platforms notified about; null = every source. */
      sources: z.array(sourceSchema).nullable(),
    })
    .nullable(),
});
export type SlackStatus = z.infer<typeof slackStatusSchema>;

export const slackChannelsResponseSchema = z.object({
  channels: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type SlackChannelsResponse = z.infer<typeof slackChannelsResponseSchema>;

export const slackNotificationsBodySchema = z.object({
  channelId: z.string().min(1).max(40),
  /** Display name captured at pick time; Slack renames do not break sends
   *  (delivery goes to the id), only the label. */
  channelName: z.string().min(1).max(90),
  minRelevance: z.coerce.number().int().min(0).max(100).optional(),
  /** Platforms to notify for; omitted or empty = every source. */
  sources: z.array(sourceSchema).max(SOURCES.length).optional(),
});
export type SlackNotificationsBody = z.infer<typeof slackNotificationsBodySchema>;

// ---------------------------------------------------------------------------
// Enterprise inquiries (public landing form)
// ---------------------------------------------------------------------------

export const enterpriseInquiryBodySchema = z.object({
  company: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  /** Free text: current or expected keyword volume. */
  keywordsEstimate: z.string().max(120).optional(),
  message: z.string().max(2000).optional(),
  /** Honeypot; bots fill it, humans never see it. */
  website: z.string().max(200).optional(),
});
export type EnterpriseInquiryBody = z.infer<typeof enterpriseInquiryBodySchema>;

// ---------------------------------------------------------------------------
// Bring-your-own source tokens (x bearer for now)
// ---------------------------------------------------------------------------

export const sourceTokenBodySchema = z.object({
  /** The raw bearer token; stored server-side, never returned. */
  token: z.string().min(20).max(500),
});

export const sourceTokenStatusSchema = z.object({
  configured: z.boolean(),
});

export const slackInstallStartResponseSchema = z.object({
  /** Slack authorize URL the client should navigate to. */
  url: z.string(),
});

// ---------------------------------------------------------------------------
// Company context
// ---------------------------------------------------------------------------

export const companyContextBodySchema = z.object({
  /** What the company does, products, competitors — fed verbatim to the
   *  classifier. The single biggest relevance lever. */
  context: z.string().max(4000),
});

/** Structured company profile; the classifier context is composed from it. */
export const companyProfileSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  useCases: z.array(z.string().min(1).max(300)).max(10),
  /** Username without the @. */
  xAccount: z.string().max(50).nullable(),
  linkedinAccount: z.string().max(100).nullable(),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

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

// ---------------------------------------------------------------------------
// Users & sessions (human auth; orgs stay the tenant)
// ---------------------------------------------------------------------------

export const orgRoleSchema = z.enum(['owner', 'admin', 'member']);

/** Identity fields mirrored from Better Auth's user table (the tables are
 *  owned by Better Auth; this shape is what OUR endpoints return). */
export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  createdAt: z.number(),
});
export type User = z.infer<typeof userSchema>;

export const orgSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  role: orgRoleSchema,
  website: z.string().nullable(),
  brandName: z.string().nullable(),
  logoUrl: z.string().nullable(),
  /** False until the onboarding flow has run for this org. */
  onboarded: z.boolean(),
});
export type OrgSummary = z.infer<typeof orgSummarySchema>;

export const meResponseSchema = z.object({
  user: userSchema,
  orgs: z.array(orgSummarySchema),
  /** The workspace this session currently acts on (organization plugin
   *  setActive, falling back to the signup workspace). */
  activeOrgId: z.string(),
});

// ---------------------------------------------------------------------------
// Onboarding (brand analysis of the user's website)
// ---------------------------------------------------------------------------

export const onboardingAnalyzeBodySchema = z.object({
  website: z.string().url(),
});

/** The LLM contract for website analysis: brand profile + starter keyword
 *  suggestions (2 space/product topics, 2 competitors). */
export const brandAnalysisSchema = z.object({
  brandName: z.string().min(1).max(80),
  context: z.string().max(4000),
  topics: z.array(z.string().min(2).max(80)).min(1).max(2),
  competitors: z.array(z.string().min(2).max(80)).min(1).max(2),
});
export type BrandAnalysis = z.infer<typeof brandAnalysisSchema>;

export const onboardingAnalyzeResponseSchema = brandAnalysisSchema.extend({
  website: z.string(),
  logoUrl: z.string().nullable(),
});
export type OnboardingAnalyzeResponse = z.infer<typeof onboardingAnalyzeResponseSchema>;

export const onboardingCompleteBodySchema = z.object({
  website: z.string().url(),
  brandName: z.string().min(1).max(80),
  logoUrl: z.string().url().nullable().optional(),
  context: z.string().max(4000).default(''),
  keywords: z.array(createKeywordBodySchema).max(10).default([]),
});
export type OnboardingCompleteBody = z.infer<typeof onboardingCompleteBodySchema>;
/** Client-side shape (before zod defaults are applied). */
export type OnboardingCompleteInput = z.input<typeof onboardingCompleteBodySchema>;

export const onboardingCompleteResponseSchema = z.object({
  ok: z.literal(true),
  keywordsCreated: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const billingStatusSchema = z.enum(['none', 'active', 'past_due', 'canceled']);
export type BillingStatus = z.infer<typeof billingStatusSchema>;

/** https only: z.url() alone admits javascript:/data:/http: targets, and the
 *  checkout success_url is where Polar sends the customer after paying. The
 *  API worker additionally enforces an origin allowlist when configured. */
export const billingCheckoutBodySchema = z.object({
  /** https everywhere; plain http only for localhost so the checkout flow is
   *  testable in local dev (the route's origin allowlist still applies). */
  successUrl: z
    .string()
    .url()
    .max(2000)
    .refine(
      (value) => {
        if (value.startsWith('https://')) return true;
        try {
          return new URL(value).hostname === 'localhost';
        } catch {
          return false;
        }
      },
      { message: 'successUrl must be https' },
    ),
});

export const billingCheckoutResponseSchema = z.object({
  url: z.string(),
});

export const billingPortalResponseSchema = z.object({
  url: z.string(),
});

/** Current-cycle usage, the shape behind GET /v1/billing/usage and the
 *  dashboard spend view. All counts are this org, this cycle. */
export const usageSummarySchema = z.object({
  cycle: z.string(),
  status: billingStatusSchema,
  activeKeywords: z.number().int().min(0),
  /** High-water mark the keyword bill line uses. */
  keywordMax: z.number().int().min(0),
  /** Every mention that matched a keyword this cycle, relevant or filtered:
   *  all of them bill. Renamed from relevantMentions when billing moved to
   *  the match (CLAUDE.md invariant 7). */
  matchedMentions: z.number().int().min(0),
  /** Flat free allowance per cycle (keywords bundle no mentions). */
  includedMentions: z.number().int().min(0),
  /** Mentions past the free allowance; each one bills EUR 0.008. */
  overageMentions: z.number().int().min(0),
  /** Billable mentions accrued so far (monotone with billedMentions). */
  billableMentions: z.number().int().min(0),
  /** Mentions already projected to Polar. */
  billedMentions: z.number().int().min(0),
  /** Present for trial-era orgs without an active subscription; null for
   *  paying and grandfathered orgs. */
  trial: z
    .object({
      endsAt: z.number().int(),
      mentionsUsed: z.number().int().min(0),
      mentionsLimit: z.number().int().min(0),
      /** Time or mention allowance ran out: tracking is stopped until upgrade. */
      expired: z.boolean(),
    })
    .nullable(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
