import { createRoute, z } from '@hono/zod-openapi';
import {
  DuplicateKeywordError,
  createKeyword,
  deleteKeyword,
  listKeywords,
  setKeywordMuted,
} from '@mentions/core/ops/keywords';
import { createKeywordBodySchema, keywordSchema } from '@mentions/core/schemas';
import { errorBody, errorResponse } from '../errors';
import { createRouter } from '../router';

const security = [{ bearerAuth: [] }];

const keywordParamsSchema = z.object({
  keywordId: z.string().min(1).openapi({ param: { name: 'keywordId', in: 'path' }, example: 'kw_abc123' }),
});

const createKeywordRoute = createRoute({
  method: 'post',
  path: '/keywords',
  operationId: 'createKeyword',
  tags: ['Keywords'],
  security,
  request: {
    body: { content: { 'application/json': { schema: createKeywordBodySchema } }, required: true },
  },
  responses: {
    201: { content: { 'application/json': { schema: keywordSchema } }, description: 'The created keyword' },
    401: errorResponse('Missing or invalid API key'),
    409: errorResponse('A keyword with the same normalized term already exists for this org'),
  },
});

const listKeywordsRoute = createRoute({
  method: 'get',
  path: '/keywords',
  operationId: 'listKeywords',
  tags: ['Keywords'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ keywords: z.array(keywordSchema) }) } },
      description: 'All keywords for the org',
    },
    401: errorResponse('Missing or invalid API key'),
  },
});

const deleteKeywordRoute = createRoute({
  method: 'delete',
  path: '/keywords/{keywordId}',
  operationId: 'deleteKeyword',
  tags: ['Keywords'],
  security,
  request: { params: keywordParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
      description: 'Keyword and its matches deleted',
    },
    401: errorResponse('Missing or invalid API key'),
    404: errorResponse('Keyword not found'),
  },
});

const muteKeywordRoute = createRoute({
  method: 'patch',
  path: '/keywords/{keywordId}',
  operationId: 'setKeywordMuted',
  tags: ['Keywords'],
  security,
  request: {
    params: keywordParamsSchema,
    body: { content: { 'application/json': { schema: z.object({ muted: z.boolean() }) } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ id: z.string(), muted: z.boolean() }) } },
      description: 'Mute state updated',
    },
    401: errorResponse('Missing or invalid API key'),
    404: errorResponse('Keyword not found'),
  },
});

export const keywordsRouter = createRouter();

keywordsRouter.openapi(createKeywordRoute, async (c) => {
  const { term, kind } = c.req.valid('json');
  try {
    const keyword = await createKeyword({ db: c.env.DB, orgId: c.get('orgId'), term, kind });
    return c.json(keyword, 201);
  } catch (err) {
    if (err instanceof DuplicateKeywordError) {
      return c.json(errorBody('duplicate_keyword', err.message), 409);
    }
    throw err;
  }
});

keywordsRouter.openapi(listKeywordsRoute, async (c) => {
  const keywords = await listKeywords({ db: c.env.DB, orgId: c.get('orgId') });
  return c.json({ keywords }, 200);
});

keywordsRouter.openapi(deleteKeywordRoute, async (c) => {
  const { keywordId } = c.req.valid('param');
  const deleted = await deleteKeyword({ db: c.env.DB, orgId: c.get('orgId'), keywordId });
  if (!deleted) {
    return c.json(errorBody('not_found', 'Keyword not found'), 404);
  }
  return c.json({ deleted: true }, 200);
});

keywordsRouter.openapi(muteKeywordRoute, async (c) => {
  const { keywordId } = c.req.valid('param');
  const { muted } = c.req.valid('json');
  const updated = await setKeywordMuted({ db: c.env.DB, orgId: c.get('orgId'), keywordId, muted });
  if (!updated) {
    return c.json(errorBody('not_found', 'Keyword not found'), 404);
  }
  return c.json({ id: keywordId, muted }, 200);
});
