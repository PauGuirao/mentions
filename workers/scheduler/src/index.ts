/**
 * mentions-scheduler: cron ticks every minute and enqueues fetch jobs.
 *
 * - Global sources (one poll covers the whole source) are gated by a
 *   per-source last-run timestamp in KV.
 * - Per-term sources are gated by a deterministic minute-slot hash so a big
 *   term registry spreads evenly across the cadence window instead of
 *   bursting every search in one tick.
 *
 * The scheduler only decides WHAT is due; cursors and fetching live in the
 * ingest worker. Losing a tick therefore delays data, never loses it.
 */
import { dayKey, enforceTrialStops, runDailyBilling } from '@mentions/core/ops/billing';
import { initObservability, withJobEvent } from '@mentions/core/observability';
import type { FetchJob } from '@mentions/core/pipeline';
import { PolarClient, resolvePolarServer } from '@mentions/core/polar';
import type { Source } from '@mentions/core/schemas';

interface Env {
  /** Axiom wide-event drain switches on when both are set. */
  AXIOM_API_KEY?: string;
  AXIOM_DATASET?: string;
  DB: D1Database;
  KV: KVNamespace;
  FETCH_JOBS: Queue<FetchJob>;
  /** Unset -> billing flush defers (same enable-by-secret pattern as source
   *  credentials): `wrangler secret put POLAR_ACCESS_TOKEN`. */
  POLAR_ACCESS_TOKEN?: string;
  /** 'sandbox' (default) or 'production'. */
  POLAR_SERVER?: string;
}

const BILLING_DAY_KEY = 'lastrun:billing-day';

/** Once per UTC day (Zernio pattern: daily cron, invoice sums at month
 *  end). The KV mark is written only after a fully successful run, so a
 *  failed day retries every minute until it lands — dedup makes that free. */
async function flushBilling(env: Env, now: number): Promise<void> {
  if (!env.POLAR_ACCESS_TOKEN) return;
  const today = dayKey(now);
  if ((await env.KV.get(BILLING_DAY_KEY)) === today) return;
  const server = resolvePolarServer(env.POLAR_SERVER);
  if (server === null) {
    console.error(`[scheduler] invalid POLAR_SERVER "${env.POLAR_SERVER}"; billing flush skipped`);
    return;
  }
  const polar = new PolarClient({ accessToken: env.POLAR_ACCESS_TOKEN, server });
  try {
    const { keywordDayEvents, mentionChargeEvents, closedCycles } = await runDailyBilling({
      db: env.DB,
      polar,
      nowMs: now,
    });
    await env.KV.put(BILLING_DAY_KEY, today);
    console.log(
      `[scheduler] daily billing: ${keywordDayEvents} keyword-day + ${mentionChargeEvents} mention-charge event(s), ${closedCycles} cycle(s) closed`,
    );
  } catch (error) {
    // The tick is re-runnable by design (external_id dedup); next tick retries.
    console.error('[scheduler] billing flush failed', { error: String(error) });
  }
}

/** Global sources: hackernews every tick, devto every 5 minutes. */
const GLOBAL_CADENCES = [
  { source: 'hackernews', cadenceMs: 60_000 },
  { source: 'devto', cadenceMs: 300_000 },
] as const satisfies ReadonlyArray<{ source: Source; cadenceMs: number }>;

/** Per-term sources: cadence expressed in minutes because due-ness is
 *  slot-based on the minute index (see below). reddit and x are scheduled
 *  unconditionally but their adapters defer (no-op, cursor kept) until
 *  credentials are configured on the ingest worker — flipping a source on is
 *  a secret put, not a deploy. x additionally sits behind a monthly read
 *  budget (see packages/core/src/sources/x.ts). */
const PER_TERM_CADENCES = [
  { source: 'github', cadenceMinutes: 5 }, // 300s
  { source: 'stackoverflow', cadenceMinutes: 1440 }, // 86400s
  // Reddit rides a paid scrape provider (per successful request), so the
  // cadence is a cost knob: 30 min ~= 1,440 req/term/month, which keeps even
  // a worst-case provider tier well under the per-keyword price.
  { source: 'reddit', cadenceMinutes: 30 }, // 1800s
  // X bills per post RETURNED (empty polls are free, since_id never
  // refetches), so cadence is a latency knob, not a cost knob; hourly is
  // just a conservative default.
  { source: 'x', cadenceMinutes: 60 },
  // YouTube search costs 100 quota units against a 10k/day default quota =
  // ~100 searches/day total. Twice daily per term keeps headroom to ~50 terms.
  { source: 'youtube', cadenceMinutes: 720 },
  // Keyless GDELT DOC API (updates every ~15 min, 1 req/5s/IP rate limit);
  // 30 min keeps us far below the limit and is plenty for news latency.
  { source: 'news', cadenceMinutes: 30 },
] as const satisfies ReadonlyArray<{ source: Source; cadenceMinutes: number }>;

/** Cron ticks are nominally 60s apart but jitter a little; without slack a
 *  59.9s gap would skip a 60s-cadence source for a whole extra minute. */
const CADENCE_SLACK_MS = 5_000;

/** Queues sendBatch caps at 100 messages per call. */
const SEND_BATCH_MAX = 100;

/** FNV-1a: tiny, deterministic, good-enough spread for slot hashing. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export default {
  async scheduled(controller, env, ctx) {
    initObservability('scheduler', env);
    await withJobEvent({
      ctx,
      event: 'cron_tick',
      fn: async (log) => {
    const now = controller.scheduledTime;
    const jobs: FetchJob[] = [];

    // Global sources: KV last-run gate.
    const dueGlobalKeys: string[] = [];
    for (const { source, cadenceMs } of GLOBAL_CADENCES) {
      const key = `lastrun:${source}`;
      const last = await env.KV.get(key);
      if (last !== null && now - Number(last) < cadenceMs - CADENCE_SLACK_MS) continue;
      jobs.push({ source, scheduledAt: now });
      dueGlobalKeys.push(key);
    }

    // Per-term sources: hash(source:term) picks a fixed minute-slot inside the
    // cadence window, so e.g. 500 GitHub terms spread across 5 ticks instead
    // of 500 searches bursting in one. Tradeoff of the stateless slot: a
    // missed cron tick skips that term for one window — the cursor makes that
    // a delay, never a loss, so no per-term KV bookkeeping is needed.
    const minuteIndex = Math.floor(now / 60_000);
    const { results: termRows } = await env.DB.prepare(
      'SELECT DISTINCT normalized_term FROM keywords WHERE muted = 0',
    ).all<{ normalized_term: string }>();

    for (const { source, cadenceMinutes } of PER_TERM_CADENCES) {
      for (const row of termRows) {
        const term = row.normalized_term;
        const slot = fnv1a(`${source}:${term}`) % cadenceMinutes;
        if (minuteIndex % cadenceMinutes !== slot) continue;
        jobs.push({ source, term, scheduledAt: now });
      }
    }

    for (let i = 0; i < jobs.length; i += SEND_BATCH_MAX) {
      await env.FETCH_JOBS.sendBatch(jobs.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })));
    }

    // Mark global last-runs only after the jobs were actually enqueued; if
    // sendBatch threw, the next tick re-decides and re-sends.
    for (const key of dueGlobalKeys) {
      await env.KV.put(key, String(now));
    }

    if (jobs.length > 0) {
      console.log(`[scheduler] enqueued ${jobs.length} fetch job(s) (terms=${termRows.length})`);
    }
    log.set({ fetchJobs: jobs.length, terms: termRows.length });

    // Full-stop finished trials before enqueueing is not required (the
    // registry query already ran), but doing it every tick keeps the stop
    // within a minute of expiry. Failures must not break polling.
    try {
      const { stoppedKeywords } = await enforceTrialStops({ db: env.DB, nowMs: now });
      if (stoppedKeywords > 0) log.set({ trialStoppedKeywords: stoppedKeywords });
    } catch (err) {
      console.error('[scheduler] trial stop sweep failed', err instanceof Error ? err.message : err);
    }

    await flushBilling(env, now);
      },
    });
  },
} satisfies ExportedHandler<Env>;
