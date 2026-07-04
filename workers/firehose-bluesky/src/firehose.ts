/**
 * FirehoseConsumer — singleton Durable Object holding one WebSocket to Bluesky
 * Jetstream, streaming post creates into the mentions-raw-items queue.
 *
 * Volume note: the full-network post stream runs at a few hundred events/s.
 * Per-event work is one JSON.parse + a few property reads + an array push —
 * no D1, and cursor persistence is throttled to ~every 2s of events.
 *
 * Delivery semantics: at-least-once. On reconnect we resume from the last
 * persisted cursor (up to ~2s behind), so a crash replays a couple of seconds
 * of duplicates; the matcher dedupes via INSERT OR IGNORE downstream.
 */
import { DurableObject } from 'cloudflare:workers';
import type { RawItemsMessage } from '@mentions/core/pipeline';
import type { RawItem } from '@mentions/core/schemas';
import { clampCursor, parseJetstreamEvent } from './jetstream';

export interface Env {
  FIREHOSE: DurableObjectNamespace<FirehoseConsumer>;
  RAW_ITEMS: Queue<RawItemsMessage>;
  ADMIN_SECRET: string;
}

export interface StatusReport {
  running: boolean;
  connected: boolean;
  /** Latest Jetstream time_us seen (may lead the persisted copy by ~2s). */
  cursor: number | null;
  cursorLagSeconds: number | null;
  buffered: number;
  consecutiveFailures: number;
  lastEventAgoMs: number | null;
}

// The wss endpoint, spelled https because outbound WebSockets in Workers go
// through fetch() + the Upgrade header.
const JETSTREAM_URL =
  'https://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';

const WATCHDOG_INTERVAL_MS = 30_000;
/** rawItemsMessageSchema caps a queue message at 50 items. */
const BATCH_MAX_ITEMS = 50;
/** Secondary flush trigger so a batch of max-length posts stays well under
 *  the 128KB queue message limit (30k UTF-16 units ≈ ≤90KB UTF-8 worst case). */
const BATCH_MAX_TEXT_UNITS = 30_000;
const BATCH_FLUSH_MS = 2_000;
const CURSOR_PERSIST_INTERVAL_MS = 2_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** On queue-send failure we re-buffer, but never hold more than this many
 *  items — beyond it the oldest are dropped (live-listening tradeoff, same
 *  rationale as the 5-minute replay cap in jetstream.ts). */
const MAX_BUFFERED_ITEMS = 500;

export class FirehoseConsumer extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private connecting = false;
  private consecutiveFailures = 0;
  private nextConnectAttemptAt = 0;
  private reconnectTimer: number | null = null;

  private batch: RawItem[] = [];
  private batchTextUnits = 0;
  private flushTimer: number | null = null;
  private flushing = false;

  private cursor: number | null = null;
  private lastCursorPersistAt = 0;
  private lastEventAt = 0;

  async start(): Promise<StatusReport> {
    await this.ctx.storage.put('running', true);
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
    // A manual/cron start bypasses any pending backoff.
    this.consecutiveFailures = 0;
    this.nextConnectAttemptAt = 0;
    await this.ensureConnected();
    return this.buildStatus(true);
  }

  async stop(): Promise<StatusReport> {
    await this.ctx.storage.put('running', false);
    await this.ctx.storage.deleteAlarm();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket('stopped');
    await this.flush(); // don't drop items already buffered
    await this.persistCursor();
    return this.buildStatus(false);
  }

  async status(): Promise<StatusReport> {
    const running = (await this.ctx.storage.get<boolean>('running')) ?? false;
    if (this.cursor === null) {
      this.cursor = (await this.ctx.storage.get<number>('cursor')) ?? null;
    }
    return this.buildStatus(running);
  }

  /** Watchdog: re-arms every 30s while running. Reconnects if the socket is
   *  gone or silently dead (the full firehose never goes 60s without an
   *  event, so prolonged silence means a half-open TCP connection). */
  async alarm(): Promise<void> {
    const running = (await this.ctx.storage.get<boolean>('running')) ?? false;
    if (!running) return;
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);

    const open = this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    const stale = this.lastEventAt > 0 && Date.now() - this.lastEventAt > WATCHDOG_INTERVAL_MS * 2;
    if (!open || stale) {
      this.closeSocket(stale ? 'stale' : 'watchdog');
      await this.ensureConnected();
    }
    // Don't let a lost timer strand buffered items (timers die with eviction).
    if (this.batch.length > 0 && this.flushTimer === null && !this.flushing) {
      void this.flush();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connecting) return;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) return;
    if (Date.now() < this.nextConnectAttemptAt) return; // still backing off

    this.connecting = true;
    try {
      const stored = this.cursor ?? (await this.ctx.storage.get<number>('cursor')) ?? null;
      const cursor = clampCursor(stored, Date.now());
      const url = new URL(JETSTREAM_URL);
      if (cursor !== null) url.searchParams.set('cursor', String(cursor));

      const response = await fetch(url.toString(), { headers: { Upgrade: 'websocket' } });
      const ws = response.webSocket;
      if (!ws) throw new Error(`Jetstream upgrade failed: HTTP ${response.status}`);
      ws.accept();
      // Events are gated on identity so a replaced/closed socket can't feed
      // stale data or double-trigger reconnects.
      ws.addEventListener('message', (event) => {
        if (this.ws === ws) this.onEvent(event);
      });
      ws.addEventListener('close', () => this.onSocketDown(ws, 'close'));
      ws.addEventListener('error', () => this.onSocketDown(ws, 'error'));

      this.ws = ws;
      this.consecutiveFailures = 0;
      this.lastEventAt = Date.now(); // grace period before the stale check can trip
      console.log('[firehose] connected', { cursor });
    } catch (error) {
      this.scheduleReconnect();
      console.error('[firehose] connect failed', {
        attempt: this.consecutiveFailures,
        error: String(error),
      });
    } finally {
      this.connecting = false;
    }
  }

  private onSocketDown(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return; // an old socket we already replaced/closed
    this.ws = null;
    console.warn('[firehose] socket down', { reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.consecutiveFailures += 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), BACKOFF_CAP_MS);
    this.nextConnectAttemptAt = Date.now() + delay;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    // The timer covers the fast path; the 30s alarm is the safety net if the
    // DO gets evicted (in-memory timers die with it, alarms don't).
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectIfRunning();
    }, delay);
  }

  private async reconnectIfRunning(): Promise<void> {
    const running = (await this.ctx.storage.get<boolean>('running')) ?? false;
    if (running) await this.ensureConnected();
  }

  /** Hot path — a few hundred calls/s. Keep allocations minimal. */
  private onEvent(event: MessageEvent): void {
    if (typeof event.data !== 'string') return; // we never request compression
    const now = Date.now();
    this.lastEventAt = now;

    const { timeUs, item } = parseJetstreamEvent(event.data);
    if (timeUs !== null && (this.cursor === null || timeUs > this.cursor)) {
      this.cursor = timeUs;
      if (now - this.lastCursorPersistAt >= CURSOR_PERSIST_INTERVAL_MS) {
        this.lastCursorPersistAt = now;
        void this.persistCursor();
      }
    }
    if (item === null) return;

    this.batch.push(item);
    this.batchTextUnits += item.text.length;
    if (this.batch.length >= BATCH_MAX_ITEMS || this.batchTextUnits >= BATCH_MAX_TEXT_UNITS) {
      void this.flush();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, BATCH_FLUSH_MS);
    }
  }

  private async persistCursor(): Promise<void> {
    if (this.cursor !== null) await this.ctx.storage.put('cursor', this.cursor);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing) return; // the in-flight drain loop will pick new items up
    this.flushing = true;
    try {
      while (this.batch.length > 0) {
        const items = this.batch.splice(0, BATCH_MAX_ITEMS);
        try {
          await this.env.RAW_ITEMS.send({ items });
        } catch (error) {
          // Re-buffer at the front and retry shortly; if the queue stays down
          // keep only the newest MAX_BUFFERED_ITEMS (drop oldest).
          this.batch = [...items, ...this.batch].slice(-MAX_BUFFERED_ITEMS);
          console.error('[firehose] queue send failed, re-buffered', {
            buffered: this.batch.length,
            error: String(error),
          });
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
          }, BATCH_FLUSH_MS);
          break;
        }
      }
    } finally {
      // splice/re-buffer under concurrent pushes makes incremental accounting
      // unreliable; recompute once per flush instead of per event.
      this.batchTextUnits = this.batch.reduce((sum, i) => sum + i.text.length, 0);
      this.flushing = false;
    }
  }

  private closeSocket(reason: string): void {
    const ws = this.ws;
    this.ws = null; // null first so this socket's close event is ignored
    if (ws !== null) {
      try {
        ws.close(1000, reason);
      } catch {
        // already closed
      }
    }
  }

  private buildStatus(running: boolean): StatusReport {
    return {
      running,
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      cursor: this.cursor,
      cursorLagSeconds:
        this.cursor === null ? null : Math.max(0, Math.round((Date.now() - this.cursor / 1000) / 1000)),
      buffered: this.batch.length,
      consecutiveFailures: this.consecutiveFailures,
      lastEventAgoMs: this.lastEventAt === 0 ? null : Date.now() - this.lastEventAt,
    };
  }
}
