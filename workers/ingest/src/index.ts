/**
 * mentions-ingest: consumes mentions-fetch-jobs, runs the matching source
 * adapter from the job's cursor, forwards normalized items to the
 * mentions-raw-items queue, then persists the advanced cursor in D1.
 *
 * Ordering is deliberate — items are SENT before the cursor is WRITTEN. If
 * the cursor write fails, the next poll re-fetches the same window and the
 * matcher dedupes on (source, externalId): reprocessing over loss, always.
 */
import {
  fetchJobSchema,
  rawItemsMessageSchema,
  type RawItemsMessage,
} from '@mentions/core/pipeline';
import type { RawItem, Source } from '@mentions/core/schemas';
import {
  createMonthlyReadMeter,
  SOURCE_ADAPTERS,
  X_DEFAULT_MONTHLY_READ_CAP,
  type BudgetMeter,
} from '@mentions/core/sources/index';

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  RAW_ITEMS: Queue<RawItemsMessage>;
  /** Optional secret; raises GitHub search from 10 to 30 req/min. */
  GITHUB_TOKEN?: string;
  /** Optional secrets (the Reddit app's credentials); until BOTH are set the
   *  reddit adapter defers every poll. */
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  /** Optional secret; until set the x adapter defers every poll. */
  X_BEARER_TOKEN?: string;
  /** Optional var; posts/month the x adapter may read (cost gate). */
  X_MONTHLY_READ_CAP?: string;
  /** Optional secret (Data API v3 key); until set the youtube adapter defers
   *  every poll. */
  YOUTUBE_API_KEY?: string;
}

/** Per-source credentials for adapter fetches; undefined means the source
 *  runs unauthenticated (github) or defers until configured (reddit, x). */
function adapterAuth(source: Source, env: Env): string | undefined {
  switch (source) {
    case 'github':
      return env.GITHUB_TOKEN;
    case 'reddit':
      return env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET
        ? `${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`
        : undefined;
    case 'x':
      return env.X_BEARER_TOKEN;
    case 'youtube':
      return env.YOUTUBE_API_KEY;
    default:
      return undefined;
  }
}

/** x is the only metered-spend source; everything else polls free APIs. */
function adapterBudget(source: Source, env: Env): BudgetMeter | undefined {
  if (source !== 'x') return undefined;
  const configured = Number.parseInt(env.X_MONTHLY_READ_CAP ?? '', 10);
  const cap = Number.isFinite(configured) && configured > 0 ? configured : X_DEFAULT_MONTHLY_READ_CAP;
  return createMonthlyReadMeter({ kv: env.KV, source, cap });
}

/** Give up on a job after this many delivery attempts (message.attempts is
 *  1-based). Kept below wrangler's max_retries so this in-code policy, with
 *  its loud log line, is what actually governs. */
const MAX_ATTEMPTS = 3;

/** rawItemsMessageSchema caps a message at 50 items... */
const CHUNK_MAX_ITEMS = 50;
/** ...but 50 items x 8KB text could blow the 128KB queue message cap, so
 *  chunks also split early on serialized size. */
const CHUNK_MAX_BYTES = 96_000;

function chunkItems(items: ReadonlyArray<RawItem>): RawItem[][] {
  const chunks: RawItem[][] = [];
  let current: RawItem[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (
      current.length >= CHUNK_MAX_ITEMS ||
      (current.length > 0 && currentBytes + size > CHUNK_MAX_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function handleMessage(message: Message<unknown>, env: Env): Promise<void> {
  const parsed = fetchJobSchema.safeParse(message.body);
  if (!parsed.success) {
    console.error('[ingest] dropping malformed fetch job:', parsed.error.message);
    message.ack();
    return;
  }
  const job = parsed.data;

  const adapter = SOURCE_ADAPTERS[job.source];
  if (!adapter) {
    // bluesky is a firehose (never scheduled); any other miss is a bug.
    console.error(`[ingest] no polling adapter for source=${job.source}; dropping job`);
    message.ack();
    return;
  }
  const term = adapter.kind === 'per-term' ? job.term : undefined;
  if (adapter.kind === 'per-term' && !term) {
    console.error(`[ingest] per-term job for source=${job.source} without a term; dropping job`);
    message.ack();
    return;
  }
  // The cursors table stores '' (not NULL) for global sources — see 0001_init.sql.
  const cursorTerm = term ?? '';

  try {
    const row = await env.DB.prepare('SELECT cursor FROM cursors WHERE source = ?1 AND term = ?2')
      .bind(job.source, cursorTerm)
      .first<{ cursor: string }>();
    const cursor = row?.cursor ?? null;

    const { items, nextCursor } = await adapter.fetchSince({
      cursor,
      term,
      auth: adapterAuth(job.source, env),
      budget: adapterBudget(job.source, env),
    });

    for (const chunk of chunkItems(items)) {
      const validated = rawItemsMessageSchema.safeParse({ items: chunk });
      if (!validated.success) {
        // Adapters validate per item, so a failing chunk is a bug; skip it
        // rather than poisoning the whole job.
        console.error(
          `[ingest] ${job.source} produced an invalid raw-items chunk; skipping:`,
          validated.error.message,
        );
        continue;
      }
      await env.RAW_ITEMS.send(validated.data);
    }

    if (nextCursor !== null && nextCursor !== cursor) {
      await env.DB.prepare(
        `INSERT INTO cursors (source, term, cursor, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(source, term) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
        .bind(job.source, cursorTerm, nextCursor, Date.now())
        .run();
    }

    if (items.length > 0) {
      console.log(`[ingest] ${job.source}${term ? `/${term}` : ''}: forwarded ${items.length} item(s)`);
    }
    message.ack();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (message.attempts >= MAX_ATTEMPTS) {
      // Loud on purpose: this poll is dropped. Safe because the cursor was
      // never advanced — the next scheduled job for this (source, term)
      // re-covers the same window, so a lost poll self-heals.
      console.error(
        `[ingest] DROPPING fetch job after ${message.attempts} attempts: source=${job.source} term=${term ?? '-'} error=${detail}`,
      );
      message.ack();
      return;
    }
    const delaySeconds = Math.min(30 * message.attempts, 300);
    console.warn(
      `[ingest] retrying source=${job.source} term=${term ?? '-'} attempt=${message.attempts} in ${delaySeconds}s: ${detail}`,
    );
    message.retry({ delaySeconds });
  }
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      await handleMessage(message, env);
    }
  },
} satisfies ExportedHandler<Env>;
