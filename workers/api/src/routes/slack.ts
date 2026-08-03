import { createRoute, z } from '@hono/zod-openapi';
import {
  SlackNotConnectedError,
  deleteSlackInstall,
  deleteSlackNotifications,
  getSlackInstall,
  getSlackStatus,
  saveSlackInstall,
  setSlackNotifications,
} from '@mentions/core/ops/slack';
import {
  SLACK_AUTH_ERRORS,
  SlackApiError,
  buildSlackAuthorizeUrl,
  exchangeSlackCode,
  listSlackChannels,
  revokeSlackToken,
} from '@mentions/core/slack';
import {
  slackChannelsResponseSchema,
  slackInstallStartResponseSchema,
  slackNotificationsBodySchema,
  slackStatusSchema,
} from '@mentions/core/schemas';
import { errorBody, errorResponse } from '../errors';
import { createRouter } from '../router';
import type { Env } from '../types';

const security = [{ bearerAuth: [] }];

/** OAuth state nonces are single-use and short-lived. */
const STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `slack_oauth:${state}`;

interface SlackCreds {
  clientId: string;
  clientSecret: string;
}

function slackCreds(env: Env): SlackCreds | null {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return null;
  return { clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET };
}

/** The redirect URI is derived from the incoming request origin, so dev and
 *  prod each match their own entry in the Slack app's redirect URL list. */
function callbackUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/v1/slack/callback`;
}

/** Where the browser lands after the OAuth dance: the dashboard settings
 *  page on the first trusted origin (dev SPA), else the auth origin. */
function settingsUrl(env: Env, result: 'connected' | 'error' | 'cancelled'): string {
  const origin =
    (env.TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .find((o) => o.length > 0) ?? env.BETTER_AUTH_URL;
  return `${origin.replace(/\/$/, '')}/settings?slack=${result}`;
}

const installRoute = createRoute({
  method: 'post',
  path: '/slack/install',
  operationId: 'startSlackInstall',
  tags: ['Slack'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: slackInstallStartResponseSchema } },
      description: 'Slack authorize URL to navigate the user to',
    },
    401: errorResponse('Missing or invalid credentials'),
    503: errorResponse('Slack integration is not configured on this deployment'),
  },
});

const statusRoute = createRoute({
  method: 'get',
  path: '/slack/status',
  operationId: 'getSlackStatus',
  tags: ['Slack'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: slackStatusSchema } },
      description: 'Connection state, workspace name, and notification config',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

const channelsRoute = createRoute({
  method: 'get',
  path: '/slack/channels',
  operationId: 'listSlackChannels',
  tags: ['Slack'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: slackChannelsResponseSchema } },
      description: 'Public channels in the connected workspace, name-sorted',
    },
    401: errorResponse('Missing or invalid credentials'),
    404: errorResponse('No Slack workspace connected (or the token was revoked)'),
    502: errorResponse('Slack API failure'),
  },
});

const setNotificationsRoute = createRoute({
  method: 'put',
  path: '/slack/notifications',
  operationId: 'setSlackNotifications',
  tags: ['Slack'],
  security,
  request: {
    body: {
      content: { 'application/json': { schema: slackNotificationsBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: slackStatusSchema } },
      description: 'Updated status after pointing notifications at the channel',
    },
    401: errorResponse('Missing or invalid credentials'),
    404: errorResponse('No Slack workspace connected'),
  },
});

const deleteNotificationsRoute = createRoute({
  method: 'delete',
  path: '/slack/notifications',
  operationId: 'deleteSlackNotifications',
  tags: ['Slack'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: slackStatusSchema } },
      description: 'Notifications disabled; the workspace stays connected',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

const disconnectRoute = createRoute({
  method: 'delete',
  path: '/slack',
  operationId: 'disconnectSlack',
  tags: ['Slack'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ disconnected: z.boolean() }) } },
      description: 'Install removed and token revoked best-effort',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

export const slackRouter = createRouter();

slackRouter.openapi(installRoute, async (c) => {
  const creds = slackCreds(c.env);
  if (!creds) {
    return c.json(errorBody('slack_not_configured', 'Slack integration is not configured'), 503);
  }
  const state = crypto.randomUUID().replaceAll('-', '');
  await c.env.KV.put(stateKey(state), JSON.stringify({ orgId: c.get('orgId') }), {
    expirationTtl: STATE_TTL_SECONDS,
  });
  const url = buildSlackAuthorizeUrl({
    clientId: creds.clientId,
    redirectUri: callbackUri(c.req.url),
    state,
  });
  return c.json({ url }, 200);
});

slackRouter.openapi(statusRoute, async (c) => {
  const status = await getSlackStatus({ db: c.env.DB, orgId: c.get('orgId') });
  return c.json({ configured: slackCreds(c.env) !== null, ...status }, 200);
});

slackRouter.openapi(channelsRoute, async (c) => {
  const install = await getSlackInstall({ db: c.env.DB, orgId: c.get('orgId') });
  if (!install) {
    return c.json(errorBody('slack_not_connected', 'No Slack workspace connected'), 404);
  }
  try {
    const channels = await listSlackChannels({ botToken: install.botToken });
    return c.json({ channels }, 200);
  } catch (err) {
    // A dead token reads as "not connected" so the UI prompts a re-install.
    if (err instanceof SlackApiError && SLACK_AUTH_ERRORS.has(err.slackError)) {
      return c.json(errorBody('slack_not_connected', 'Slack token is no longer valid'), 404);
    }
    if (err instanceof SlackApiError) {
      return c.json(errorBody('internal_error', err.message), 502);
    }
    throw err;
  }
});

slackRouter.openapi(setNotificationsRoute, async (c) => {
  const body = c.req.valid('json');
  try {
    await setSlackNotifications({
      db: c.env.DB,
      orgId: c.get('orgId'),
      channelId: body.channelId,
      channelName: body.channelName,
      minRelevance: body.minRelevance,
    });
  } catch (err) {
    if (err instanceof SlackNotConnectedError) {
      return c.json(errorBody('slack_not_connected', err.message), 404);
    }
    throw err;
  }
  const status = await getSlackStatus({ db: c.env.DB, orgId: c.get('orgId') });
  return c.json({ configured: slackCreds(c.env) !== null, ...status }, 200);
});

slackRouter.openapi(deleteNotificationsRoute, async (c) => {
  await deleteSlackNotifications({ db: c.env.DB, orgId: c.get('orgId') });
  const status = await getSlackStatus({ db: c.env.DB, orgId: c.get('orgId') });
  return c.json({ configured: slackCreds(c.env) !== null, ...status }, 200);
});

slackRouter.openapi(disconnectRoute, async (c) => {
  const botToken = await deleteSlackInstall({ db: c.env.DB, orgId: c.get('orgId') });
  if (botToken) c.executionCtx.waitUntil(revokeSlackToken({ botToken }));
  return c.json({ disconnected: botToken !== null }, 200);
});

/** Plain (non-OpenAPI) route: Slack redirects the user's browser here, so it
 *  authenticates via the single-use state nonce, not bearer credentials
 *  (excluded from the auth middleware in auth.ts). */
export function registerSlackCallback(app: ReturnType<typeof createRouter>): void {
  app.get('/slack/callback', async (c) => {
    const creds = slackCreds(c.env);
    if (!creds) {
      return c.json(errorBody('slack_not_configured', 'Slack integration is not configured'), 503);
    }

    // User hit "Cancel" on the consent screen.
    if (c.req.query('error')) {
      return c.redirect(settingsUrl(c.env, 'cancelled'), 302);
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return c.redirect(settingsUrl(c.env, 'error'), 302);
    }

    const stored = await c.env.KV.get(stateKey(state));
    if (!stored) {
      return c.redirect(settingsUrl(c.env, 'error'), 302);
    }
    await c.env.KV.delete(stateKey(state));

    let orgId: string;
    try {
      orgId = z.object({ orgId: z.string().min(1) }).parse(JSON.parse(stored)).orgId;
    } catch {
      return c.redirect(settingsUrl(c.env, 'error'), 302);
    }

    try {
      const grant = await exchangeSlackCode({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri: callbackUri(c.req.url),
      });
      await saveSlackInstall({ db: c.env.DB, orgId, grant });
    } catch (err) {
      console.error('[slack] OAuth exchange failed', err);
      return c.redirect(settingsUrl(c.env, 'error'), 302);
    }

    return c.redirect(settingsUrl(c.env, 'connected'), 302);
  });
}
