/**
 * Thin Slack Web API client for the OAuth install flow and channel listing.
 * Transport only (same rule as polar.ts): ops/slack.ts decides what gets
 * stored, and the deliverer worker owns message sending with the stored bot
 * token. Slack reports most failures as HTTP 200 + { ok: false, error }, so
 * every call funnels through the same ok-check.
 */
import { z } from 'zod';

/** chat:write.public lets the bot post to any public channel without being
 *  invited; channels:read powers the channel picker. */
export const SLACK_BOT_SCOPES = ['chat:write', 'chat:write.public', 'channels:read'] as const;

/** Slack errors that mean the token itself is dead and the org must
 *  re-install, as opposed to a transient or config problem. */
export const SLACK_AUTH_ERRORS = new Set(['invalid_auth', 'token_revoked', 'account_inactive']);

export class SlackApiError extends Error {
  readonly slackError: string;

  constructor(slackError: string) {
    super(`slack error: ${slackError}`);
    this.slackError = slackError;
  }
}

const slackErrorSchema = z.object({ ok: z.literal(false), error: z.string() });

const oauthAccessSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  bot_user_id: z.string().min(1),
  scope: z.string(),
  team: z.object({ id: z.string().min(1), name: z.string() }),
});

const channelsPageSchema = z.object({
  ok: z.literal(true),
  channels: z.array(z.object({ id: z.string().min(1), name: z.string() })),
  response_metadata: z.object({ next_cursor: z.string() }).optional(),
});

export interface SlackInstallGrant {
  botToken: string;
  botUserId: string;
  teamId: string;
  teamName: string;
  scope: string;
}

export function buildSlackAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('state', args.state);
  return url.toString();
}

async function parseSlackResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new SlackApiError(`http_${response.status}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SlackApiError('non_json_response');
  }
  const failed = slackErrorSchema.safeParse(json);
  if (failed.success) throw new SlackApiError(failed.data.error);
  return json;
}

export async function exchangeSlackCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<SlackInstallGrant> {
  const doFetch = args.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
  });
  const response = await doFetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const parsed = oauthAccessSchema.parse(await parseSlackResponse(response));
  return {
    botToken: parsed.access_token,
    botUserId: parsed.bot_user_id,
    teamId: parsed.team.id,
    teamName: parsed.team.name,
    scope: parsed.scope,
  };
}

const CHANNEL_PAGE_LIMIT = 200;
const MAX_CHANNEL_PAGES = 5;

/** Public, non-archived channels, name-sorted. Capped at
 *  MAX_CHANNEL_PAGES x CHANNEL_PAGE_LIMIT for giant workspaces. */
export async function listSlackChannels(args: {
  botToken: string;
  fetchImpl?: typeof fetch;
}): Promise<Array<{ id: string; name: string }>> {
  const doFetch = args.fetchImpl ?? fetch;
  const channels: Array<{ id: string; name: string }> = [];
  let cursor = '';
  for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
    const url = new URL('https://slack.com/api/conversations.list');
    url.searchParams.set('types', 'public_channel');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', String(CHANNEL_PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await doFetch(url.toString(), {
      headers: { authorization: `Bearer ${args.botToken}` },
    });
    const parsed = channelsPageSchema.parse(await parseSlackResponse(response));
    channels.push(...parsed.channels);
    cursor = parsed.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

/** Best effort: a failed revoke leaves a dead token on Slack's side, which
 *  is harmless once our install row is gone. */
export async function revokeSlackToken(args: {
  botToken: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const doFetch = args.fetchImpl ?? fetch;
  try {
    await doFetch('https://slack.com/api/auth.revoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${args.botToken}` },
    });
  } catch {
    // Swallowed by design; see doc comment.
  }
}
