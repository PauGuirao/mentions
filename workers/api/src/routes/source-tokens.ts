/**
 * Bring-your-own X bearer token, per org. The token is write-only through the
 * API: status reads expose only a configured flag. Ingest picks it up on the
 * next poll of any term the org tracks (platform X_BEARER_TOKEN wins when set).
 */
import { createRoute } from '@hono/zod-openapi';
import {
  deleteSourceToken,
  hasSourceToken,
  setSourceToken,
} from '@mentions/core/ops/source-tokens';
import { sourceTokenBodySchema, sourceTokenStatusSchema } from '@mentions/core/schemas';
import { errorResponse } from '../errors';
import { createRouter } from '../router';

const security = [{ bearerAuth: [] }];

const statusRoute = createRoute({
  method: 'get',
  path: '/sources/x/token',
  operationId: 'getXSourceToken',
  tags: ['Sources'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: sourceTokenStatusSchema } },
      description: 'Whether this org has a custom X bearer token configured',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/sources/x/token',
  operationId: 'setXSourceToken',
  tags: ['Sources'],
  security,
  request: {
    body: { content: { 'application/json': { schema: sourceTokenBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: sourceTokenStatusSchema } },
      description: 'Token stored; X polling for this org\'s terms uses it from the next poll',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/sources/x/token',
  operationId: 'deleteXSourceToken',
  tags: ['Sources'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: sourceTokenStatusSchema } },
      description: 'Token removed',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

export const sourceTokensRouter = createRouter();

sourceTokensRouter.openapi(statusRoute, async (c) => {
  const configured = await hasSourceToken({ db: c.env.DB, orgId: c.get('orgId'), source: 'x' });
  return c.json({ configured }, 200);
});

sourceTokensRouter.openapi(putRoute, async (c) => {
  const { token } = c.req.valid('json');
  await setSourceToken({ db: c.env.DB, orgId: c.get('orgId'), source: 'x', token });
  return c.json({ configured: true }, 200);
});

sourceTokensRouter.openapi(deleteRoute, async (c) => {
  await deleteSourceToken({ db: c.env.DB, orgId: c.get('orgId'), source: 'x' });
  return c.json({ configured: false }, 200);
});
