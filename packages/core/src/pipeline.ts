/**
 * Queue names + message contracts for every pipeline stage. This file is the
 * only place a queue name or message shape may be defined; workers import
 * from here so a stage can never drift from its neighbors.
 *
 * Flow: fetch-<source> -> raw-items -> classify -> deliver
 */
import { z } from 'zod';
import { rawItemSchema, sourceSchema } from './schemas';

export const QUEUES = {
  /** Scheduler -> ingest worker. One logical fetch job per message. */
  fetchJobs: 'mentions-fetch-jobs',
  /** Ingest/firehose -> matcher. Batched RawItems. */
  rawItems: 'mentions-raw-items',
  /** Matcher -> classifier. One tenant-scoped match per message. */
  classify: 'mentions-classify',
  /** Classifier -> deliverer. Matches that cleared the relevance bar. */
  deliver: 'mentions-deliver',
} as const;

/** Scheduler job: poll one source, optionally scoped to one normalized term
 *  (search-API sources poll per DISTINCT term across all orgs). */
export const fetchJobSchema = z.object({
  source: sourceSchema,
  term: z.string().optional(),
  scheduledAt: z.number().int(),
});
export type FetchJob = z.infer<typeof fetchJobSchema>;

/** Ingest -> matcher. Items are already normalized; matcher dedupes on
 *  (source, externalId) via INSERT OR IGNORE. */
export const rawItemsMessageSchema = z.object({
  items: z.array(rawItemSchema).min(1).max(50),
});
export type RawItemsMessage = z.infer<typeof rawItemsMessageSchema>;

/** Matcher -> classifier. References, not payloads: the classifier re-reads
 *  the mention text from D1 so queue messages stay tiny. */
export const classifyJobSchema = z.object({
  mentionMatchId: z.string(),
  orgId: z.string(),
});
export type ClassifyJob = z.infer<typeof classifyJobSchema>;

/** Classifier -> deliverer. */
export const deliverJobSchema = z.object({
  mentionMatchId: z.string(),
  orgId: z.string(),
});
export type DeliverJob = z.infer<typeof deliverJobSchema>;
