import { createMiddleware } from 'hono/factory';
import { verifyApiKey } from '@mentions/core/ops/api-keys';
import { getOrgForUser } from '@mentions/core/ops/org-members';
import { getAuth } from './better-auth';
import { errorBody } from './errors';
import type { AppEnv } from './types';

/** The Polar webhook authenticates via HMAC signature inside its handler,
 *  not via bearer credentials. */
const PUBLIC_PATHS = new Set(['/v1/health', '/v1/openapi.json', '/v1/webhooks/polar']);
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
    return next();
  }

  // Humans: Better Auth session (cookie; header pass-through covers plugins).
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (session) {
    const orgId = await getOrgForUser({ db: c.env.DB, userId: session.user.id });
    if (!orgId) {
      return c.json(errorBody('unauthorized', 'User has no workspace'), 401);
    }
    c.set('orgId', orgId);
    c.set('userId', session.user.id);
    return next();
  }

  return c.json(errorBody('unauthorized', 'Missing or invalid credentials'), 401);
});
