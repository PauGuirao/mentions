/**
 * Observability: one WIDE EVENT per unit of work (HTTP request, queue batch,
 * cron tick), shipped to Axiom through evlog's drain. The api worker uses
 * evlog's Hono middleware directly; every other worker funnels through
 * withJobEvent below.
 *
 * Enable-by-secret like every integration here: without AXIOM_API_KEY the
 * drain is never configured and events still print to the console (visible
 * in Cloudflare's own logs), so a missing secret degrades, never breaks.
 */
import { createRequestLogger, initLogger, type AuditableLogger } from 'evlog';
import { createAxiomDrain } from 'evlog/axiom';

export interface ObservabilityEnv {
  AXIOM_API_KEY?: string;
  AXIOM_DATASET?: string;
}

let initialized = false;

/** Idempotent per-isolate init; call at the top of every handler (env
 *  bindings only exist at request time on Workers). */
export function initObservability(service: string, env: ObservabilityEnv): void {
  if (initialized) return;
  initialized = true;
  if (env.AXIOM_API_KEY && env.AXIOM_DATASET) {
    initLogger({
      env: { service },
      drain: createAxiomDrain({ apiKey: env.AXIOM_API_KEY, dataset: env.AXIOM_DATASET }),
    });
  } else {
    initLogger({ env: { service } });
  }
}

export type JobLogger = AuditableLogger<Record<string, unknown>>;

interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Run background work under one wide event. The drain promise is registered
 * with ctx.waitUntil so the Axiom send survives the handler returning.
 * Errors are recorded on the event and RETHROWN — queue retry semantics stay
 * untouched.
 */
export async function withJobEvent<T>(args: {
  ctx: WaitUntilCtx;
  event: string;
  fields?: Record<string, unknown>;
  fn: (log: JobLogger) => Promise<T>;
}): Promise<T> {
  const log = createRequestLogger<Record<string, unknown>>({
    waitUntil: args.ctx.waitUntil.bind(args.ctx),
  });
  log.set({ event: args.event, ...args.fields });
  try {
    const result = await args.fn(log);
    log.emit();
    return result;
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)));
    log.emit();
    throw error;
  }
}
