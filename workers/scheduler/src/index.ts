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
import type { FetchJob } from '@mentions/core/pipeline';
import type { Source } from '@mentions/core/schemas';

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  FETCH_JOBS: Queue<FetchJob>;
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
  { source: 'reddit', cadenceMinutes: 10 }, // 600s
  { source: 'x', cadenceMinutes: 60 }, // 3600s, kept coarse to respect the read budget
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
  async scheduled(controller, env) {
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
  },
} satisfies ExportedHandler<Env>;
