/**
 * Drizzle schema for every PRODUCT table, mirroring migrations 0001-0007
 * column for column. The SQL migrations in ../../migrations stay the source
 * of truth for what exists in D1 (applied via `wrangler d1 migrations`);
 * this file is the typed view the ops layer queries through. The test
 * harness runs the real migrations and queries them through this schema, so
 * drift between the two fails tests.
 *
 * Deliberately absent: Better Auth's tables (user, session, account,
 * verification from 0003) — Better Auth owns their shape and access.
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const orgs = sqliteTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'),
  companyContext: text('company_context').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  // 0004 brand onboarding
  website: text('website'),
  brandName: text('brand_name'),
  logoUrl: text('logo_url'),
  onboardedAt: integer('onboarded_at'),
  // 0005 company profile
  description: text('description').notNull().default(''),
  useCases: text('use_cases').notNull().default('[]'),
  xAccount: text('x_account'),
  linkedinAccount: text('linkedin_account'),
});

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    name: text('name').notNull().default('default'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [uniqueIndex('sqlite_autoindex_api_keys_key_hash').on(t.keyHash), index('idx_api_keys_org').on(t.orgId)],
);

export const keywords = sqliteTable(
  'keywords',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    term: text('term').notNull(),
    normalizedTerm: text('normalized_term').notNull(),
    kind: text('kind', { enum: ['brand', 'competitor', 'topic'] })
      .notNull()
      .default('brand'),
    muted: integer('muted').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('keywords_org_normalized').on(t.orgId, t.normalizedTerm)],
);

export const mentions = sqliteTable(
  'mentions',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    author: text('author'),
    authorUrl: text('author_url'),
    text: text('text').notNull(),
    publishedAt: integer('published_at').notNull(),
    rawR2Key: text('raw_r2_key'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('mentions_source_external').on(t.source, t.externalId), index('idx_mentions_published').on(t.publishedAt)],
);

export const mentionMatches = sqliteTable(
  'mention_matches',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    mentionId: text('mention_id')
      .notNull()
      .references(() => mentions.id),
    keywordId: text('keyword_id')
      .notNull()
      .references(() => keywords.id),
    state: text('state', {
      enum: ['matched', 'classified', 'filtered', 'delivered', 'ignored', 'done'],
    })
      .notNull()
      .default('matched'),
    relevance: integer('relevance'),
    sentiment: text('sentiment', { enum: ['positive', 'neutral', 'negative'] }),
    intents: text('intents'),
    aiNote: text('ai_note'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('matches_org_mention_keyword').on(t.orgId, t.mentionId, t.keywordId),
    index('idx_matches_org_created').on(t.orgId, t.createdAt),
    index('idx_matches_org_state').on(t.orgId, t.state),
  ],
);

export const feeds = sqliteTable(
  'feeds',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    filter: text('filter').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_feeds_org').on(t.orgId)],
);

export const destinations = sqliteTable('destinations', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  type: text('type', { enum: ['webhook', 'slack'] }).notNull(),
  config: text('config').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const feedDestinations = sqliteTable(
  'feed_destinations',
  {
    feedId: text('feed_id')
      .notNull()
      .references(() => feeds.id),
    destinationId: text('destination_id')
      .notNull()
      .references(() => destinations.id),
  },
  (t) => [primaryKey({ columns: [t.feedId, t.destinationId] })],
);

export const deliveries = sqliteTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    feedId: text('feed_id').notNull(),
    destinationId: text('destination_id').notNull(),
    mentionMatchId: text('mention_match_id').notNull(),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    deliveredAt: integer('delivered_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('deliveries_destination_match').on(t.destinationId, t.mentionMatchId)],
);

export const cursors = sqliteTable(
  'cursors',
  {
    source: text('source').notNull(),
    term: text('term').notNull().default(''),
    cursor: text('cursor').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.term] })],
);

/** user_id references Better Auth's "user" table (not modeled here). */
export const orgMembers = sqliteTable(
  'org_members',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    userId: text('user_id').notNull(),
    role: text('role', { enum: ['owner', 'member'] }).notNull().default('owner'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index('idx_org_members_user').on(t.userId)],
);

export const orgBilling = sqliteTable('org_billing', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id),
  polarCustomerId: text('polar_customer_id'),
  polarSubscriptionId: text('polar_subscription_id'),
  status: text('status', { enum: ['none', 'active', 'past_due', 'canceled'] })
    .notNull()
    .default('none'),
  currentPeriodStart: integer('current_period_start'),
  currentPeriodEnd: integer('current_period_end'),
  updatedAt: integer('updated_at').notNull(),
});

export const usageCycles = sqliteTable(
  'usage_cycles',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    cycle: text('cycle').notNull(),
    relevantMentions: integer('relevant_mentions').notNull().default(0),
    keywordMax: integer('keyword_max').notNull().default(0),
    billedUnits: integer('billed_units').notNull().default(0),
    settledAt: integer('settled_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.cycle] })],
);

export const billableMentions = sqliteTable(
  'billable_mentions',
  {
    mentionMatchId: text('mention_match_id').primaryKey(),
    orgId: text('org_id').notNull(),
    cycle: text('cycle').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_billable_org_cycle').on(t.orgId, t.cycle)],
);

export const slackInstalls = sqliteTable('slack_installs', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id),
  teamId: text('team_id').notNull(),
  teamName: text('team_name').notNull(),
  botUserId: text('bot_user_id').notNull(),
  botToken: text('bot_token').notNull(),
  scope: text('scope').notNull(),
  installedAt: integer('installed_at').notNull(),
  feedId: text('feed_id').references(() => feeds.id),
  destinationId: text('destination_id').references(() => destinations.id),
  channelId: text('channel_id'),
  channelName: text('channel_name'),
});
