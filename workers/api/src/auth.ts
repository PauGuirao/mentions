import { createMiddleware } from 'hono/factory';
import { verifyApiKey } from '@mentions/core/ops/api-keys';
import { verifySession } from '@mentions/core/ops/sessions';
import { errorBody } from './errors';
import type { AppEnv } from './types';

const PUBLIC_PATHS = new Set(['/v1/health', '/v1/openapi.json', '/v1/auth/signup', '/v1/auth/login']);

export const auth = createMiddleware<AppEnv>(async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) {
    return next();
  }

  const header = c.req.header('authorization');
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice('bearer '.length).trim() : undefined;
  if (!token) {
    return c.json(errorBody('unauthorized', 'Missing bearer token'), 401);
  }

  // Two credential kinds share the Bearer scheme: sess_ session tokens
  // (humans, carry a user) and mk_live_ API keys (machines, org only).
  if (token.startsWith('sess_')) {
    const session = await verifySession({ db: c.env.DB, kv: c.env.KV, token });
    if (!session) {
      return c.json(errorBody('unauthorized', 'Invalid or expired session'), 401);
    }
    c.set('orgId', session.orgId);
    c.set('userId', session.userId);
    return next();
  }

  const verified = await verifyApiKey({ db: c.env.DB, kv: c.env.KV, token });
  if (!verified) {
    return c.json(errorBody('unauthorized', 'Invalid API key'), 401);
  }

  c.set('orgId', verified.orgId);
  await next();
});
