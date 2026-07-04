import { createMiddleware } from 'hono/factory';
import { verifyApiKey } from '@mentions/core/ops/api-keys';
import { errorBody } from './errors';
import type { AppEnv } from './types';

const PUBLIC_PATHS = new Set(['/v1/health', '/v1/openapi.json']);

export const auth = createMiddleware<AppEnv>(async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) {
    return next();
  }

  const header = c.req.header('authorization');
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice('bearer '.length).trim() : undefined;
  if (!token) {
    return c.json(errorBody('unauthorized', 'Missing bearer token'), 401);
  }

  const verified = await verifyApiKey({ db: c.env.DB, kv: c.env.KV, token });
  if (!verified) {
    return c.json(errorBody('unauthorized', 'Invalid API key'), 401);
  }

  c.set('orgId', verified.orgId);
  await next();
});
