/**
 * Slack integration ops: one workspace install per org (slack_installs) plus
 * one MANAGED "Slack notifications" feed + destination pair, created when the
 * user picks a channel. The deliverer stays completely unaware of installs:
 * the bot token is denormalized into the destination config it already
 * understands ({botToken, channel}), and a re-install refreshes that copy.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { deliveries, destinations, feedDestinations, feeds, slackInstalls } from '../db/schema';
import { newId } from '../ids';
import { feedFilterSchema, type SlackStatus, type Source } from '../schemas';
import type { SlackInstallGrant } from '../slack';

export class SlackNotConnectedError extends Error {
  constructor() {
    super('No Slack workspace is connected; run the install flow first');
  }
}

const MANAGED_FEED_NAME = 'Slack notifications';

export type SlackInstall = typeof slackInstalls.$inferSelect;

export async function getSlackInstall(args: {
  db: D1Database;
  orgId: string;
}): Promise<SlackInstall | null> {
  const row = await getDb(args.db)
    .select()
    .from(slackInstalls)
    .where(eq(slackInstalls.orgId, args.orgId))
    .get();
  return row ?? null;
}

/** Insert or refresh the org's install. A re-install keeps the managed
 *  notification wiring and rewrites the token copy the deliverer reads. */
export async function saveSlackInstall(args: {
  db: D1Database;
  orgId: string;
  grant: SlackInstallGrant;
  now?: number;
}): Promise<void> {
  const { db, orgId, grant } = args;
  const orm = getDb(db);
  const now = args.now ?? Date.now();
  await orm
    .insert(slackInstalls)
    .values({
      orgId,
      teamId: grant.teamId,
      teamName: grant.teamName,
      botUserId: grant.botUserId,
      botToken: grant.botToken,
      scope: grant.scope,
      installedAt: now,
    })
    .onConflictDoUpdate({
      target: slackInstalls.orgId,
      set: {
        teamId: grant.teamId,
        teamName: grant.teamName,
        botUserId: grant.botUserId,
        botToken: grant.botToken,
        scope: grant.scope,
        installedAt: now,
      },
    });

  const install = await getSlackInstall({ db, orgId });
  if (install?.destinationId && install.channelId) {
    await orm
      .update(destinations)
      .set({ config: JSON.stringify({ botToken: grant.botToken, channel: install.channelId }) })
      .where(and(eq(destinations.id, install.destinationId), eq(destinations.orgId, orgId)));
  }
}

/** Everything the settings UI needs except `configured`, which only the API
 *  worker knows (it owns the OAuth credentials). */
export async function getSlackStatus(args: {
  db: D1Database;
  orgId: string;
}): Promise<Omit<SlackStatus, 'configured'>> {
  const install = await getSlackInstall(args);
  if (!install) return { connected: false, teamName: null, notifications: null };

  let notifications: SlackStatus['notifications'] = null;
  if (install.feedId && install.channelId && install.channelName) {
    let minRelevance: number | null = null;
    let sources: Source[] | null = null;
    const feed = await getDb(args.db)
      .select({ filter: feeds.filter })
      .from(feeds)
      .where(and(eq(feeds.id, install.feedId), eq(feeds.orgId, args.orgId)))
      .get();
    if (feed) {
      try {
        const filter = feedFilterSchema.safeParse(JSON.parse(feed.filter));
        if (filter.success) {
          minRelevance = filter.data.minRelevance ?? null;
          sources = filter.data.sources?.length ? filter.data.sources : null;
        }
      } catch {
        // Unparseable filter: surface the channel anyway; delivery skips it.
      }
    }
    notifications = {
      channelId: install.channelId,
      channelName: install.channelName,
      minRelevance,
      sources,
    };
  }

  return { connected: true, teamName: install.teamName, notifications };
}

/** Create or update the managed feed + destination pair as one batch. */
export async function setSlackNotifications(args: {
  db: D1Database;
  orgId: string;
  channelId: string;
  channelName: string;
  minRelevance?: number | undefined;
  /** Platforms to notify for; omitted or empty = every source. */
  sources?: readonly Source[] | undefined;
  now?: number;
}): Promise<void> {
  const { db, orgId, channelId, channelName, minRelevance, sources } = args;
  const orm = getDb(db);
  const install = await getSlackInstall({ db, orgId });
  if (!install) throw new SlackNotConnectedError();

  const now = args.now ?? Date.now();
  const filter = JSON.stringify({
    ...(minRelevance === undefined ? {} : { minRelevance }),
    ...(sources && sources.length > 0 ? { sources } : {}),
  });
  const config = JSON.stringify({ botToken: install.botToken, channel: channelId });

  if (install.feedId && install.destinationId) {
    await orm.batch([
      orm.update(feeds).set({ filter }).where(and(eq(feeds.id, install.feedId), eq(feeds.orgId, orgId))),
      orm
        .update(destinations)
        .set({ config })
        .where(and(eq(destinations.id, install.destinationId), eq(destinations.orgId, orgId))),
      orm
        .update(slackInstalls)
        .set({ channelId, channelName })
        .where(eq(slackInstalls.orgId, orgId)),
    ]);
    return;
  }

  const feedId = newId('feed');
  const destinationId = newId('dest');
  await orm.batch([
    orm.insert(feeds).values({ id: feedId, orgId, name: MANAGED_FEED_NAME, filter, createdAt: now }),
    orm.insert(destinations).values({ id: destinationId, orgId, type: 'slack', config, createdAt: now }),
    orm.insert(feedDestinations).values({ feedId, destinationId }),
    orm
      .update(slackInstalls)
      .set({ feedId, destinationId, channelId, channelName })
      .where(eq(slackInstalls.orgId, orgId)),
  ]);
}

/** Tear down the managed pair (delivery history included; FK order matters). */
export async function deleteSlackNotifications(args: {
  db: D1Database;
  orgId: string;
}): Promise<void> {
  const { db, orgId } = args;
  const orm = getDb(db);
  const install = await getSlackInstall({ db, orgId });
  if (!install?.feedId || !install.destinationId) return;

  await orm.batch([
    orm
      .delete(deliveries)
      .where(and(eq(deliveries.destinationId, install.destinationId), eq(deliveries.orgId, orgId))),
    orm
      .delete(feedDestinations)
      .where(
        and(
          eq(feedDestinations.feedId, install.feedId),
          eq(feedDestinations.destinationId, install.destinationId),
        ),
      ),
    orm
      .update(slackInstalls)
      .set({ feedId: null, destinationId: null, channelId: null, channelName: null })
      .where(eq(slackInstalls.orgId, orgId)),
    orm
      .delete(destinations)
      .where(and(eq(destinations.id, install.destinationId), eq(destinations.orgId, orgId))),
    orm.delete(feeds).where(and(eq(feeds.id, install.feedId), eq(feeds.orgId, orgId))),
  ]);
}

/** Remove the whole connection. Returns the bot token so the API layer can
 *  best-effort revoke it with Slack after the rows are gone. */
export async function deleteSlackInstall(args: {
  db: D1Database;
  orgId: string;
}): Promise<string | null> {
  const install = await getSlackInstall(args);
  if (!install) return null;
  await deleteSlackNotifications(args);
  await getDb(args.db).delete(slackInstalls).where(eq(slackInstalls.orgId, args.orgId));
  return install.botToken;
}
