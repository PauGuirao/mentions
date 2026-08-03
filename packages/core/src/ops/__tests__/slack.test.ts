import { describe, expect, it } from 'vitest';
import type { SlackInstallGrant } from '../../slack';
import {
  SlackNotConnectedError,
  deleteSlackInstall,
  deleteSlackNotifications,
  getSlackStatus,
  saveSlackInstall,
  setSlackNotifications,
} from '../slack';
import { createTestD1, seedOrg } from './d1-sqlite';

const GRANT: SlackInstallGrant = {
  botToken: 'xoxb-token',
  botUserId: 'U1',
  teamId: 'T1',
  teamName: 'Acme',
  scope: 'chat:write',
};

async function connected(): Promise<D1Database> {
  const db = createTestD1();
  await seedOrg(db, 'org_1');
  await saveSlackInstall({ db, orgId: 'org_1', grant: GRANT, now: 1 });
  return db;
}

const tableCount = async (db: D1Database, table: string): Promise<number> => {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
};

describe('setSlackNotifications', () => {
  it('creates the managed feed + destination pair on first configure', async () => {
    const db = await connected();
    await setSlackNotifications({
      db,
      orgId: 'org_1',
      channelId: 'C1',
      channelName: 'general',
      minRelevance: 70,
      now: 123,
    });

    const feed = await db.prepare('SELECT name, filter FROM feeds').first<{ name: string; filter: string }>();
    expect(feed).toEqual({ name: 'Slack notifications', filter: '{"minRelevance":70}' });
    const destination = await db
      .prepare('SELECT type, config FROM destinations')
      .first<{ type: string; config: string }>();
    // The deliverer's contract: config JSON is {botToken, channel}.
    expect(destination).toEqual({
      type: 'slack',
      config: JSON.stringify({ botToken: 'xoxb-token', channel: 'C1' }),
    });
    expect(await tableCount(db, 'feed_destinations')).toBe(1);
  });

  it('updates the existing pair in place when reconfigured', async () => {
    const db = await connected();
    await setSlackNotifications({ db, orgId: 'org_1', channelId: 'C1', channelName: 'general', minRelevance: 70 });
    await setSlackNotifications({ db, orgId: 'org_1', channelId: 'C9', channelName: 'alerts' });

    expect(await tableCount(db, 'feeds')).toBe(1);
    expect(await tableCount(db, 'destinations')).toBe(1);
    const feed = await db.prepare('SELECT filter FROM feeds').first<{ filter: string }>();
    // No minRelevance -> empty filter (deliver everything relevant).
    expect(feed?.filter).toBe('{}');
    const destination = await db.prepare('SELECT config FROM destinations').first<{ config: string }>();
    expect(destination?.config).toBe(JSON.stringify({ botToken: 'xoxb-token', channel: 'C9' }));
  });

  it('rejects when no workspace is connected', async () => {
    const db = createTestD1();
    await seedOrg(db, 'org_1');
    await expect(
      setSlackNotifications({ db, orgId: 'org_1', channelId: 'C1', channelName: 'general' }),
    ).rejects.toBeInstanceOf(SlackNotConnectedError);
  });
});

describe('saveSlackInstall', () => {
  it('re-install refreshes the token copy inside the managed destination', async () => {
    const db = await connected();
    await setSlackNotifications({ db, orgId: 'org_1', channelId: 'C1', channelName: 'general' });

    await saveSlackInstall({
      db,
      orgId: 'org_1',
      grant: { ...GRANT, botToken: 'xoxb-rotated' },
      now: 2,
    });

    const destination = await db.prepare('SELECT config FROM destinations').first<{ config: string }>();
    expect(destination?.config).toBe(JSON.stringify({ botToken: 'xoxb-rotated', channel: 'C1' }));
    const status = await getSlackStatus({ db, orgId: 'org_1' });
    expect(status.notifications?.channelId).toBe('C1');
  });
});

describe('getSlackStatus', () => {
  it('reads minRelevance back from the managed feed filter', async () => {
    const db = await connected();
    await setSlackNotifications({ db, orgId: 'org_1', channelId: 'C1', channelName: 'general', minRelevance: 70 });
    await expect(getSlackStatus({ db, orgId: 'org_1' })).resolves.toEqual({
      connected: true,
      teamName: 'Acme',
      notifications: { channelId: 'C1', channelName: 'general', minRelevance: 70 },
    });
  });

  it('reports disconnected when no install exists', async () => {
    const db = createTestD1();
    await seedOrg(db, 'org_1');
    await expect(getSlackStatus({ db, orgId: 'org_1' })).resolves.toEqual({
      connected: false,
      teamName: null,
      notifications: null,
    });
  });
});

describe('teardown', () => {
  it('deleteSlackNotifications removes the pair and its deliveries, keeps the install', async () => {
    const db = await connected();
    await setSlackNotifications({ db, orgId: 'org_1', channelId: 'C1', channelName: 'general' });
    const destination = await db.prepare('SELECT id FROM destinations').first<{ id: string }>();
    await db
      .prepare(
        `INSERT INTO deliveries (id, org_id, feed_id, destination_id, mention_match_id, created_at)
         SELECT 'del_1', 'org_1', f.id, ?1, 'mm_1', 1 FROM feeds f`,
      )
      .bind(destination!.id)
      .run();

    await deleteSlackNotifications({ db, orgId: 'org_1' });
    for (const table of ['feeds', 'destinations', 'feed_destinations', 'deliveries']) {
      expect(await tableCount(db, table), table).toBe(0);
    }
    const status = await getSlackStatus({ db, orgId: 'org_1' });
    expect(status).toEqual({ connected: true, teamName: 'Acme', notifications: null });
  });

  it('deleteSlackInstall removes everything and returns the token for revocation', async () => {
    const db = await connected();
    await setSlackNotifications({ db, orgId: 'org_1', channelId: 'C1', channelName: 'general' });
    await expect(deleteSlackInstall({ db, orgId: 'org_1' })).resolves.toBe('xoxb-token');
    expect(await tableCount(db, 'slack_installs')).toBe(0);
    expect(await tableCount(db, 'feeds')).toBe(0);
    await expect(deleteSlackInstall({ db, orgId: 'org_1' })).resolves.toBeNull();
  });
});
