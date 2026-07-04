/**
 * Pure Bluesky Jetstream event handling, kept free of DO/runtime state so the
 * mapping rules are unit-testable.
 *
 * Jetstream emits one JSON object per WebSocket message. Only `commit` events
 * that create an `app.bsky.feed.post` record become RawItems; every event
 * still yields its `time_us` so the cursor tracks real stream progress.
 */
import type { RawItem } from '@mentions/core/schemas';

export interface ParsedJetstreamEvent {
  /** Jetstream cursor (microseconds since epoch); null if unreadable. */
  timeUs: number | null;
  /** Set only for app.bsky.feed.post creates with non-empty text. */
  item: RawItem | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

export function parseJetstreamEvent(raw: string): ParsedJetstreamEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { timeUs: null, item: null };
  }
  const event = asRecord(parsed);
  if (!event) return { timeUs: null, item: null };

  const timeUs =
    typeof event.time_us === 'number' && Number.isFinite(event.time_us) && event.time_us > 0
      ? event.time_us
      : null;

  if (event.kind !== 'commit') return { timeUs, item: null };
  const commit = asRecord(event.commit);
  if (!commit || commit.operation !== 'create' || commit.collection !== 'app.bsky.feed.post') {
    return { timeUs, item: null };
  }

  const did = typeof event.did === 'string' ? event.did : '';
  const rkey = typeof commit.rkey === 'string' ? commit.rkey : '';
  const record = asRecord(commit.record);
  const text = record && typeof record.text === 'string' ? record.text : '';
  // Image/video-only posts have empty text — nothing for the matcher to see.
  if (!did || !rkey || text.length === 0) return { timeUs, item: null };

  // createdAt is client-supplied and occasionally garbage (year 0, invalid);
  // fall back to Jetstream's server-side receive time (time_us).
  let publishedAt = record && typeof record.createdAt === 'string' ? Date.parse(record.createdAt) : Number.NaN;
  if (!Number.isFinite(publishedAt) || publishedAt <= 0) {
    publishedAt = timeUs !== null ? Math.floor(timeUs / 1000) : Date.now();
  }

  return {
    timeUs,
    item: {
      source: 'bluesky',
      externalId: `${did}/${rkey}`,
      url: `https://bsky.app/profile/${did}/post/${rkey}`,
      text,
      publishedAt,
      // The DID, not the human handle — handle resolution is a later feature.
      author: did,
    },
  };
}

/** Max backlog we replay after downtime. This is a live-listening product:
 *  replaying hours of full-firehose backlog would pin the DO on catch-up work
 *  and surface stale mentions late, so anything older than 5 minutes is
 *  deliberately dropped. */
export const MAX_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Clamp a stored cursor (time_us) into the allowed replay window.
 *  null = no cursor = connect at the live tip. */
export function clampCursor(storedTimeUs: number | null, nowMs: number): number | null {
  if (storedTimeUs === null) return null;
  return Math.max(storedTimeUs, (nowMs - MAX_REPLAY_WINDOW_MS) * 1000);
}
