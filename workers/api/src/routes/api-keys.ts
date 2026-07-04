import { createRoute, z } from '@hono/zod-openapi';
import { listApiKeys, mintApiKey, revokeApiKey } from '@mentions/core/ops/api-keys';
import { errorBody, errorResponse } from '../errors';
import { createRouter } from '../router';

const security = [{ bearerAuth: [] }];

const createApiKeyBodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
});

const apiKeyParamsSchema = z.object({
  apiKeyId: z.string().min(1).openapi({ param: { name: 'apiKeyId', in: 'path' }, example: 'key_abc123' }),
});

const apiKeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});

const createApiKeyRoute = createRoute({
  method: 'post',
  path: '/api-keys',
  operationId: 'createApiKey',
  tags: ['API keys'],
  security,
  request: {
    body: { content: { 'application/json': { schema: createApiKeyBodySchema } }, required: true },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({ id: z.string(), key: z.string(), prefix: z.string() }),
        },
      },
      description: 'The minted key. Shown once; only its hash is stored.',
    },
    401: errorResponse('Missing or invalid API key'),
  },
});

const listApiKeysRoute = createRoute({
  method: 'get',
  path: '/api-keys',
  operationId: 'listApiKeys',
  tags: ['API keys'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ apiKeys: z.array(apiKeySummarySchema) }) } },
      description: 'All API keys for the org (prefixes only, never full keys)',
    },
    401: errorResponse('Missing or invalid API key'),
  },
});

const revokeApiKeyRoute = createRoute({
  method: 'delete',
  path: '/api-keys/{apiKeyId}',
  operationId: 'revokeApiKey',
  tags: ['API keys'],
  security,
  request: { params: apiKeyParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ revoked: z.boolean() }) } },
      description: 'Key revoked and its verify cache evicted',
    },
    401: errorResponse('Missing or invalid API key'),
    404: errorResponse('API key not found'),
  },
});

export const apiKeysRouter = createRouter();

apiKeysRouter.openapi(createApiKeyRoute, async (c) => {
  const { name } = c.req.valid('json');
  const minted = await mintApiKey({ db: c.env.DB, orgId: c.get('orgId'), name });
  return c.json(minted, 201);
});

apiKeysRouter.openapi(listApiKeysRoute, async (c) => {
  const apiKeys = await listApiKeys({ db: c.env.DB, orgId: c.get('orgId') });
  return c.json({ apiKeys }, 200);
});

apiKeysRouter.openapi(revokeApiKeyRoute, async (c) => {
  const { apiKeyId } = c.req.valid('param');
  const revoked = await revokeApiKey({ db: c.env.DB, kv: c.env.KV, orgId: c.get('orgId'), apiKeyId });
  if (!revoked) {
    return c.json(errorBody('not_found', 'API key not found'), 404);
  }
  return c.json({ revoked: true }, 200);
});
