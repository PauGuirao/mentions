/**
 * Registry of polling source adapters, keyed by source. Import via
 * '@mentions/core/sources/index'.
 *
 * bluesky has NO entry here on purpose: it's a firehose consumed by a
 * Durable Object, not a polled adapter, so the scheduler never enqueues a
 * fetch job for it and the ingest worker treats it as unknown.
 */
import type { Source } from '../schemas';
import type { SourceAdapter } from './types';
import { devtoAdapter } from './devto';
import { githubAdapter } from './github';
import { hackernewsAdapter } from './hackernews';
import { redditAdapter } from './reddit';
import { stackoverflowAdapter } from './stackoverflow';
import { xAdapter } from './x';
import { youtubeAdapter } from './youtube';

export type { BudgetMeter, SourceAdapter } from './types';
export {
  devtoAdapter,
  githubAdapter,
  hackernewsAdapter,
  redditAdapter,
  stackoverflowAdapter,
  xAdapter,
  youtubeAdapter,
};
export { createMonthlyReadMeter, X_DEFAULT_MONTHLY_READ_CAP } from './x';

export const SOURCE_ADAPTERS: Partial<Record<Source, SourceAdapter>> = {
  hackernews: hackernewsAdapter,
  github: githubAdapter,
  stackoverflow: stackoverflowAdapter,
  devto: devtoAdapter,
  reddit: redditAdapter,
  x: xAdapter,
  youtube: youtubeAdapter,
};
