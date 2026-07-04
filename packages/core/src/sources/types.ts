import type { RawItem, Source } from '../schemas';

/**
 * Contract every polling source adapter implements. The ingest worker is the
 * only caller: it loads the cursor from D1, calls fetchSince, forwards the
 * items to the raw-items queue, then persists nextCursor. Adapters never talk
 * to D1 or queues themselves.
 *
 * Cursor is an opaque string owned by the adapter (each source uses its API's
 * native unit — see the header comment in each adapter). Boundary compares
 * are inclusive on purpose: re-fetching the newest already-seen item is fine
 * because the matcher dedupes on (source, externalId). Reprocessing over loss.
 */
export interface SourceAdapter {
  source: Source;
  /** 'global': one poll covers the whole source (term-less job).
   *  'per-term': one poll per DISTINCT unmuted normalized term. */
  kind: 'global' | 'per-term';
  fetchSince(args: {
    /** Value from the `cursors` table, or null on the first ever poll. */
    cursor: string | null;
    /** Required for 'per-term' adapters; ignored by 'global' ones. */
    term?: string;
    /** Injected in tests; defaults to the runtime's global fetch. */
    fetchImpl?: typeof fetch;
    /** Optional API token/key for rate headroom (e.g. GITHUB_TOKEN). */
    auth?: string;
    /** Spend tracker for adapters that hit metered paid APIs (x). Provided by
     *  the ingest worker; the guard logic itself lives in the adapter. */
    budget?: BudgetMeter;
  }): Promise<{ items: RawItem[]; nextCursor: string | null }>;
}

/**
 * Spend tracker for metered paid APIs. The adapter consults `remaining()`
 * before spending and debits `record()` with what it actually consumed; the
 * caller (ingest worker) supplies the storage. This is a SOFT guard: debits
 * are read-modify-write on eventually consistent KV, so concurrent polls can
 * slightly overshoot — set caps with headroom, never bill against them.
 */
export interface BudgetMeter {
  /** Units still spendable in the current window. */
  remaining(): Promise<number>;
  /** Debit units actually consumed. */
  record(units: number): Promise<void>;
}
