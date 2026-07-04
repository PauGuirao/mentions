/**
 * mentions-classifier: consumes QUEUES.classify, scores each tenant-scoped
 * match with Workers AI, and forwards matches that clear RELEVANCE_THRESHOLD
 * to QUEUES.deliver.
 *
 * State machine (mention_matches.state):
 *   matched -> classified (relevance >= threshold, deliver job enqueued)
 *   matched -> filtered   (relevance <  threshold, kept queryable, no delivery)
 *   matched -> classified with relevance NULL + ai_note 'classification_failed'
 *              (LLM unusable twice; the pipeline never blocks on the model)
 */
import { QUEUES, classifyJobSchema, type DeliverJob } from '@mentions/core/pipeline';
import type { Classification } from '@mentions/core/schemas';
import {
  CLASSIFIER_MODEL,
  RELEVANCE_THRESHOLD,
  buildClassifyMessages,
  buildJsonRetryMessages,
  extractResponseText,
  parseClassificationResponse,
  type ChatMessage,
} from './classify';

interface Env {
  DB: D1Database;
  AI: Ai;
  DELIVER: Queue<DeliverJob>;
}

/** Everything the prompt needs, in one round trip. */
interface ClassifyRow {
  match_id: string;
  state: string;
  relevance: number | null;
  mention_text: string;
  source: string;
  keyword_term: string;
  company_context: string;
}

async function runModel(env: Env, messages: ChatMessage[]): Promise<string | null> {
  try {
    const output = await env.AI.run(CLASSIFIER_MODEL, { messages, max_tokens: 400 });
    return extractResponseText(output);
  } catch (err) {
    console.error('[classifier] AI.run failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * One model call, one nudged retry. Any failure mode (binding error, empty
 * reply, unparseable JSON) counts as a failed attempt; two failures -> null.
 */
async function classifyWithRetry(
  env: Env,
  args: { companyContext: string; keywordTerm: string; mentionText: string; source: string },
): Promise<Classification | null> {
  const messages = buildClassifyMessages(args);

  const first = await runModel(env, messages);
  if (first !== null) {
    const parsed = parseClassificationResponse(first);
    if (parsed) return parsed;
  }

  const second = await runModel(env, buildJsonRetryMessages({ messages, badReply: first ?? '' }));
  return second !== null ? parseClassificationResponse(second) : null;
}

async function handleJob(env: Env, job: { mentionMatchId: string; orgId: string }): Promise<void> {
  const { mentionMatchId, orgId } = job;

  const row = await env.DB.prepare(
    `SELECT mm.id AS match_id, mm.state AS state, mm.relevance AS relevance,
            m.text AS mention_text, m.source AS source,
            k.term AS keyword_term, o.company_context AS company_context
     FROM mention_matches mm
     JOIN mentions m ON m.id = mm.mention_id
     JOIN keywords k ON k.id = mm.keyword_id
     JOIN orgs o ON o.id = mm.org_id
     WHERE mm.id = ?1 AND mm.org_id = ?2`,
  )
    .bind(mentionMatchId, orgId)
    .first<ClassifyRow>();

  if (!row) {
    console.warn(`[classifier] match ${mentionMatchId} not found for org ${orgId}, acking`);
    return;
  }

  if (row.state !== 'matched') {
    // Idempotency on redelivery: someone already moved this match on. One
    // repair case: a previous run classified above threshold but crashed
    // before the deliver enqueue. Re-sending is safe because the deliverer
    // dedupes on deliveries(destination_id, mention_match_id).
    if (row.state === 'classified' && row.relevance !== null && row.relevance >= RELEVANCE_THRESHOLD) {
      await env.DELIVER.send({ mentionMatchId, orgId });
    }
    return;
  }

  const classification = await classifyWithRetry(env, {
    companyContext: row.company_context,
    keywordTerm: row.keyword_term,
    mentionText: row.mention_text,
    source: row.source,
  });

  if (!classification) {
    await env.DB.prepare(
      `UPDATE mention_matches
       SET state = 'classified', relevance = NULL, sentiment = NULL, intents = NULL,
           ai_note = 'classification_failed'
       WHERE id = ?1 AND org_id = ?2 AND state = 'matched'`,
    )
      .bind(mentionMatchId, orgId)
      .run();
    console.warn(`[classifier] classification_failed for match ${mentionMatchId}`);
    return;
  }

  const nextState = classification.relevance >= RELEVANCE_THRESHOLD ? 'classified' : 'filtered';
  const update = await env.DB.prepare(
    `UPDATE mention_matches
     SET state = ?1, relevance = ?2, sentiment = ?3, intents = ?4, ai_note = ?5
     WHERE id = ?6 AND org_id = ?7 AND state = 'matched'`,
  )
    .bind(
      nextState,
      classification.relevance,
      classification.sentiment,
      JSON.stringify(classification.intents),
      classification.note,
      mentionMatchId,
      orgId,
    )
    .run();

  // changes === 0 means a concurrent consumer won the state transition; it
  // owns the deliver enqueue too, so we must not double-send here.
  if (nextState === 'classified' && update.meta.changes > 0) {
    await env.DELIVER.send({ mentionMatchId, orgId });
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue !== QUEUES.classify) {
      console.error(`[classifier] unexpected queue ${batch.queue}, acking batch`);
      batch.ackAll();
      return;
    }

    for (const message of batch.messages) {
      const parsed = classifyJobSchema.safeParse(message.body);
      if (!parsed.success) {
        console.error('[classifier] malformed job, acking', parsed.error.message);
        message.ack();
        continue;
      }
      try {
        await handleJob(env, parsed.data);
        message.ack();
      } catch (err) {
        // Infrastructure errors (D1 hiccup, queue send failure): let the
        // queue redeliver; handleJob is idempotent on the state column.
        console.error(`[classifier] job ${parsed.data.mentionMatchId} failed, retrying`, err);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
