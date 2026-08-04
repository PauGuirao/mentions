import { createMiddleware } from 'hono/factory';
import { verifyApiKey } from '@mentions/core/ops/api-keys';
import { getOrgForUser, isOrgMember } from '@mentions/core/ops/org-members';
import type { Context } from 'hono';
import { getAuth } from './better-auth';
import { errorBody } from './errors';
import type { AppEnv } from './types';

/** Tag the request's wide event with tenant identity; never let telemetry
 *  break auth. */
function tagEvent(c: Context<AppEnv>, fields: Record<string, unknown>): void {
  try {
    c.get('log')?.set(fields);
  } catch {
    // Middleware not mounted (tests); the event just goes untagged.
  }
}

/** The Polar webhook authenticates via HMAC signature inside its handler,
 *  and the Slack OAuth callback via its single-use state nonce; neither
 *  carries bearer credentials. */
const PUBLIC_PATHS = new Set([
  '/v1/health',
  '/v1/openapi.json',
  '/v1/webhooks/polar',
  '/v1/slack/callback',
  // Landing contact form; unauthenticated by design (honeypot in the route).
  '/v1/enterprise/inquiries',
]);
/** Better Auth owns this namespace; its handler does its own auth. */
const AUTH_PREFIX = '/v1/auth/';

export const auth = createMiddleware<AppEnv>(async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path) || c.req.path.startsWith(AUTH_PREFIX)) {
    return next();
  }

  const header = c.req.header('authorization');
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice('bearer '.length).trim() : undefined;

  // Machines: org-scoped API keys via the Authorization header.
  if (token?.startsWith('mk_live_')) {
    const verified = await verifyApiKey({ db: c.env.DB, kv: c.env.KV, token });
    if (!verified) {
      return c.json(errorBody('unauthorized', 'Invalid API key'), 401);
    }
    c.set('orgId', verified.orgId);
    tagEvent(c, { orgId: verified.orgId, authKind: 'api_key' });
    return next();
  }

  // Humans: Better Auth session (cookie; header pass-through covers plugins).
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (session) {
    // The org plugin's setActive() picks the workspace; validate membership
    // so a stale pointer (member removed) never grants access. Fallback:
    // oldest membership (the signup workspace).
    const active = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
    let orgId: string | null = null;
    if (active && (await isOrgMember({ db: c.env.DB, userId: session.user.id, orgId: active }))) {
      orgId = active;
    }
    orgId ??= await getOrgForUser({ db: c.env.DB, userId: session.user.id });
    if (!orgId) {
      return c.json(errorBody('unauthorized', 'User has no workspace'), 401);
    }
    c.set('orgId', orgId);
    c.set('userId', session.user.id);
    tagEvent(c, { orgId, userId: session.user.id, authKind: 'session' });
    return next();
  }

  return c.json(errorBody('unauthorized', 'Missing or invalid credentials'), 401);
});
