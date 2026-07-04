/**
 * mentions-matcher — consumes mentions-raw-items, matches items against the
 * active term registry (KV-cached, 60s TTL), persists mentions + tenant
 * matches, and fans newly created matches out to mentions-classify.
 */
import { buildMatcher, type TermEntry } from '@mentions/core/match';
import { listActiveTermsWithSubscribers } from '@mentions/core/ops/keywords';
import { rawItemsMessageSchema, type ClassifyJob } from '@mentions/core/pipeline';
import { processRawItems, type MatchPayload } from './process';

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  CLASSIFY: Queue<ClassifyJob>;
}

const TERMS_CACHE_KEY = 'terms:v1';
const TERMS_CACHE_TTL_SECONDS = 60;
/** Queues sendBatch hard limit (messages per call). */
const SEND_BATCH_MAX = 100;

type TermRegistry = Awaited<ReturnType<typeof listActiveTermsWithSubscribers>>;

async function loadTermEntries(env: Env): Promise<Array<TermEntry<MatchPayload>>> {
  let registry = await env.KV.get<TermRegistry>(TERMS_CACHE_KEY, 'json');
  if (registry === null) {
    registry = await listActiveTermsWithSubscribers({ db: env.DB });
    await env.KV.put(TERMS_CACHE_KEY, JSON.stringify(registry), {
      expirationTtl: TERMS_CACHE_TTL_SECONDS,
    });
  }
  return registry.flatMap((term) =>
    term.subscribers.map((subscriber) => ({
      normalizedTerm: term.normalizedTerm,
      payload: { orgId: subscriber.orgId, keywordId: subscriber.keywordId },
    })),
  );
}

async function sendClassifyJobs(env: Env, jobs: ClassifyJob[]): Promise<void> {
  for (let i = 0; i < jobs.length; i += SEND_BATCH_MAX) {
    await env.CLASSIFY.sendBatch(jobs.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })));
  }
}

export default {
  async queue(batch, env): Promise<void> {
    // One registry load + matcher build per delivered batch (≤20 messages).
    const match = buildMatcher(await loadTermEntries(env));

    for (const message of batch.messages) {
      const parsed = rawItemsMessageSchema.safeParse(message.body);
      if (!parsed.success) {
        // A malformed body will never parse; retrying would loop it forever.
        console.error('[matcher] dropping malformed raw-items message', {
          messageId: message.id,
          issues: parsed.error.issues,
        });
        message.ack();
        continue;
      }

      try {
        const { classifyJobs, matchedItems } = await processRawItems({
          items: parsed.data.items,
          match,
          db: env.DB,
        });
        if (classifyJobs.length > 0) await sendClassifyJobs(env, classifyJobs);
        if (matchedItems > 0) {
          console.log('[matcher] matched', {
            items: parsed.data.items.length,
            matchedItems,
            classifyJobs: classifyJobs.length,
          });
        }
        message.ack();
      } catch (error) {
        console.error('[matcher] processing failed, retrying message', {
          messageId: message.id,
          error: String(error),
        });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, unknown>;
