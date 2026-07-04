/**
 * mentions-deliverer: consumes QUEUES.deliver and fans a classified match out
 * to every feed whose filter matches, then to each feed's destinations.
 *
 * Retry model (IMPORTANT): message.retry() re-runs the WHOLE job. That is
 * safe because delivery state lives in the deliveries table, keyed by the
 * UNIQUE(destination_id, mention_match_id) constraint:
 *   - INSERT OR IGNORE means a redelivery reuses the existing row;
 *   - rows already status='delivered' are skipped before any send;
 *   - only failed/pending destinations are re-attempted, each send bumping
 *     attempts, and we stop asking for redelivery once every still-failing
 *     destination has attempts >= 5 or failed permanently (non-transient).
 *
 * mention_matches.state flips classified -> delivered only when at least one
 * delivery exists and all of them succeeded. A match with no matching feed
 * (or feeds with no destinations) stays 'classified': nothing was delivered,
 * so claiming 'delivered' would lie to the read model.
 */
import { QUEUES, deliverJobSchema, type DeliverJob } from '@mentions/core/pipeline';
import { feedFilterSchema, destinationConfigSchema, type Mention } from '@mentions/core/schemas';
import { evalFeedFilter } from '@mentions/core/feed-eval';
import { newId } from '@mentions/core/ids';
import { getMention } from '@mentions/core/ops/mentions';
import { sendToDestination, type DestinationConfig } from './destinations';

interface Env {
  DB: D1Database;
}

const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_DELAY_SECONDS = 30;

interface FeedRow {
  id: string;
  filter: string;
}

interface DestinationRow {
  feed_id: string;
  destination_id: string;
  type: string;
  config: string;
}

interface DeliveryRow {
  id: string;
  status: string;
  attempts: number;
}

/** Parse the stored config JSON, re-attaching the table's type column as the
 *  discriminant (config JSON is {url,secret} | {botToken,channel}, per 0001). */
function parseDestinationConfig(row: DestinationRow): DestinationConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.config);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parsed = destinationConfigSchema.safeParse({ ...(raw as Record<string, unknown>), type: row.type });
  return parsed.success ? parsed.data : null;
}

async function loadMatchingDestinations(args: {
  env: Env;
  orgId: string;
  mention: Mention;
}): Promise<Array<{ feedId: string; row: DestinationRow }>> {
  const { env, orgId, mention } = args;

  const { results: feeds } = await env.DB.prepare('SELECT id, filter FROM feeds WHERE org_id = ?1')
    .bind(orgId)
    .all<FeedRow>();

  const matchedFeedIds: string[] = [];
  for (const feed of feeds) {
    let filterJson: unknown;
    try {
      filterJson = JSON.parse(feed.filter);
    } catch {
      console.error(`[deliverer] feed ${feed.id} has unparseable filter JSON, skipping feed`);
      continue;
    }
    const filter = feedFilterSchema.safeParse(filterJson);
    if (!filter.success) {
      console.error(`[deliverer] feed ${feed.id} has invalid filter shape, skipping feed`);
      continue;
    }
    if (evalFeedFilter(filter.data, mention)) matchedFeedIds.push(feed.id);
  }
  if (matchedFeedIds.length === 0) return [];

  const { results: destinationRows } = await env.DB.prepare(
    `SELECT fd.feed_id AS feed_id, d.id AS destination_id, d.type AS type, d.config AS config
     FROM feed_destinations fd
     JOIN destinations d ON d.id = fd.destination_id
     WHERE d.org_id = ?1 AND fd.feed_id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(orgId, JSON.stringify(matchedFeedIds))
    .all<DestinationRow>();

  // The same destination linked from two matching feeds gets ONE delivery;
  // that is exactly what UNIQUE(destination_id, mention_match_id) enforces,
  // so dedupe in memory too (first feed wins the deliveries.feed_id slot).
  const byDestination = new Map<string, { feedId: string; row: DestinationRow }>();
  for (const row of destinationRows) {
    if (!byDestination.has(row.destination_id)) {
      byDestination.set(row.destination_id, { feedId: row.feed_id, row });
    }
  }
  return [...byDestination.values()];
}

/** Outcome for one destination within one job run. */
type DeliveryOutcome = 'delivered' | 'failed_transient' | 'failed_permanent';

async function deliverToDestination(args: {
  env: Env;
  orgId: string;
  mention: Mention;
  feedId: string;
  row: DestinationRow;
}): Promise<DeliveryOutcome> {
  const { env, orgId, mention, feedId, row } = args;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO deliveries
       (id, org_id, feed_id, destination_id, mention_match_id, status, attempts, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6)`,
  )
    .bind(newId('del'), orgId, feedId, row.destination_id, mention.id, Date.now())
    .run();

  const delivery = await env.DB.prepare(
    'SELECT id, status, attempts FROM deliveries WHERE destination_id = ?1 AND mention_match_id = ?2',
  )
    .bind(row.destination_id, mention.id)
    .first<DeliveryRow>();
  if (!delivery) {
    // Row vanished between insert and read; treat as transient and let the
    // redelivery sort it out.
    return 'failed_transient';
  }

  if (delivery.status === 'delivered') return 'delivered';
  if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) return 'failed_permanent';

  const markFailed = async (error: string): Promise<void> => {
    await env.DB.prepare(
      'UPDATE deliveries SET status = ?1, attempts = attempts + 1, last_error = ?2 WHERE id = ?3',
    )
      .bind('failed', error.slice(0, 500), delivery.id)
      .run();
  };

  const config = parseDestinationConfig(row);
  if (!config) {
    await markFailed('invalid destination config');
    return 'failed_permanent';
  }

  const outcome = await sendToDestination({ config, mention });
  if (outcome.ok) {
    await env.DB.prepare(
      "UPDATE deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL, delivered_at = ?1 WHERE id = ?2",
    )
      .bind(Date.now(), delivery.id)
      .run();
    return 'delivered';
  }

  await markFailed(outcome.error);
  const attemptsAfter = delivery.attempts + 1;
  return outcome.transient && attemptsAfter < MAX_DELIVERY_ATTEMPTS
    ? 'failed_transient'
    : 'failed_permanent';
}

async function handleJob(env: Env, job: DeliverJob): Promise<'ack' | 'retry'> {
  const { mentionMatchId, orgId } = job;

  const mention = await getMention({ db: env.DB, orgId, mentionMatchId });
  if (!mention) {
    console.warn(`[deliverer] match ${mentionMatchId} not found for org ${orgId}, acking`);
    return 'ack';
  }

  // Only 'classified' proceeds. 'delivered' means a previous run finished;
  // 'ignored'/'done' means a user triaged the mention before delivery ran;
  // 'matched'/'filtered' should never be enqueued at all.
  if (mention.state !== 'classified') return 'ack';

  const targets = await loadMatchingDestinations({ env, orgId, mention });
  if (targets.length === 0) return 'ack';

  const outcomes: DeliveryOutcome[] = [];
  for (const target of targets) {
    outcomes.push(
      await deliverToDestination({ env, orgId, mention, feedId: target.feedId, row: target.row }),
    );
  }

  if (outcomes.every((o) => o === 'delivered')) {
    await env.DB.prepare(
      "UPDATE mention_matches SET state = 'delivered' WHERE id = ?1 AND org_id = ?2 AND state = 'classified'",
    )
      .bind(mentionMatchId, orgId)
      .run();
    return 'ack';
  }

  // Ask for redelivery only while a transient failure still has attempts
  // left; permanently failed destinations keep their 'failed' row + error
  // for the API to surface, and the match stays 'classified'.
  return outcomes.includes('failed_transient') ? 'retry' : 'ack';
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue !== QUEUES.deliver) {
      console.error(`[deliverer] unexpected queue ${batch.queue}, acking batch`);
      batch.ackAll();
      return;
    }

    for (const message of batch.messages) {
      const parsed = deliverJobSchema.safeParse(message.body);
      if (!parsed.success) {
        console.error('[deliverer] malformed job, acking', parsed.error.message);
        message.ack();
        continue;
      }
      try {
        const verdict = await handleJob(env, parsed.data);
        if (verdict === 'retry') {
          message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
        } else {
          message.ack();
        }
      } catch (err) {
        console.error(`[deliverer] job ${parsed.data.mentionMatchId} crashed, retrying`, err);
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      }
    }
  },
} satisfies ExportedHandler<Env>;
