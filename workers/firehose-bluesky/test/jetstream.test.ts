import { describe, expect, it } from 'vitest';
import { rawItemSchema } from '@mentions/core/schemas';
import { clampCursor, MAX_REPLAY_WINDOW_MS, parseJetstreamEvent } from '../src/jetstream';

const DID = 'did:plc:abc123xyz';
const RKEY = '3l3qo2vutsw2b';
const TIME_US = 1_780_000_000_000_000; // microseconds

function postCreateEvent(
  overrides: Partial<{
    did: string;
    timeUs: number;
    kind: string;
    operation: string;
    collection: string;
    text: string;
    createdAt: string;
  }> = {},
): string {
  const {
    did = DID,
    timeUs = TIME_US,
    kind = 'commit',
    operation = 'create',
    collection = 'app.bsky.feed.post',
    text = 'Just tried Acme today, impressed',
    createdAt = '2026-07-01T12:00:00.000Z',
  } = overrides;
  return JSON.stringify({
    did,
    time_us: timeUs,
    kind,
    commit: {
      rev: '3l3qo2vuts123',
      operation,
      collection,
      rkey: RKEY,
      cid: 'bafyreib2rxk3rw6dfnpq',
      record: { $type: 'app.bsky.feed.post', createdAt, text, langs: ['en'] },
    },
  });
}

describe('parseJetstreamEvent', () => {
  it('maps an app.bsky.feed.post create to a RawItem', () => {
    const { timeUs, item } = parseJetstreamEvent(postCreateEvent());
    expect(timeUs).toBe(TIME_US);
    expect(item).toEqual({
      source: 'bluesky',
      externalId: `${DID}/${RKEY}`,
      url: `https://bsky.app/profile/${DID}/post/${RKEY}`,
      text: 'Just tried Acme today, impressed',
      publishedAt: Date.parse('2026-07-01T12:00:00.000Z'),
      author: DID,
    });
    // The mapped item must be valid against the pipeline contract.
    expect(rawItemSchema.safeParse(item).success).toBe(true);
  });

  it('returns the cursor but no item for non-commit kinds', () => {
    const raw = JSON.stringify({ did: DID, time_us: TIME_US, kind: 'identity', identity: {} });
    expect(parseJetstreamEvent(raw)).toEqual({ timeUs: TIME_US, item: null });
  });

  it('ignores deletes and updates', () => {
    expect(parseJetstreamEvent(postCreateEvent({ operation: 'delete' })).item).toBeNull();
    expect(parseJetstreamEvent(postCreateEvent({ operation: 'update' })).item).toBeNull();
  });

  it('ignores other collections', () => {
    const { timeUs, item } = parseJetstreamEvent(postCreateEvent({ collection: 'app.bsky.feed.like' }));
    expect(item).toBeNull();
    expect(timeUs).toBe(TIME_US); // cursor still advances
  });

  it('skips posts with empty text (image/video-only)', () => {
    expect(parseJetstreamEvent(postCreateEvent({ text: '' })).item).toBeNull();
  });

  it('falls back to time_us when createdAt is unparseable', () => {
    const { item } = parseJetstreamEvent(postCreateEvent({ createdAt: 'not-a-date' }));
    expect(item?.publishedAt).toBe(Math.floor(TIME_US / 1000));
  });

  it('falls back to time_us when createdAt is nonsense-old (client clock garbage)', () => {
    const { item } = parseJetstreamEvent(postCreateEvent({ createdAt: '0000-01-01T00:00:00.000Z' }));
    expect(item?.publishedAt).toBe(Math.floor(TIME_US / 1000));
  });

  it('returns nulls for invalid JSON', () => {
    expect(parseJetstreamEvent('{oops')).toEqual({ timeUs: null, item: null });
    expect(parseJetstreamEvent('42')).toEqual({ timeUs: null, item: null });
  });
});

describe('clampCursor', () => {
  const NOW_MS = 1_780_000_500_000;

  it('passes null through (connect at live tip)', () => {
    expect(clampCursor(null, NOW_MS)).toBeNull();
  });

  it('keeps a recent cursor as-is', () => {
    const recent = (NOW_MS - 60_000) * 1000;
    expect(clampCursor(recent, NOW_MS)).toBe(recent);
  });

  it('clamps a stale cursor to the 5-minute replay window', () => {
    const stale = (NOW_MS - 60 * 60 * 1000) * 1000; // an hour behind
    expect(clampCursor(stale, NOW_MS)).toBe((NOW_MS - MAX_REPLAY_WINDOW_MS) * 1000);
  });
});
