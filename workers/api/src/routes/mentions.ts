import { createRoute, z } from '@hono/zod-openapi';
import {
  InvalidCursorError,
  getMention,
  searchMentions,
  setMentionState,
} from '@mentions/core/ops/mentions';
import { matchStateSchema, mentionSchema, searchMentionsQuerySchema } from '@mentions/core/schemas';
import { errorBody, errorResponse } from '../errors';
import { createRouter } from '../router';

const security = [{ bearerAuth: [] }];

const mentionParamsSchema = z.object({
  id: z.string().min(1).openapi({ param: { name: 'id', in: 'path' }, example: 'mm_abc123' }),
});

const listMentionsRoute = createRoute({
  method: 'get',
  path: '/mentions',
  operationId: 'searchMentions',
  tags: ['Mentions'],
  security,
  request: { query: searchMentionsQuerySchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ mentions: z.array(mentionSchema), nextCursor: z.string().nullable() }),
        },
      },
      description: 'Mentions matching the filters, newest first, keyset-paginated',
    },
    400: errorResponse('Invalid query or pagination cursor'),
    401: errorResponse('Missing or invalid API key'),
  },
});

const getMentionRoute = createRoute({
  method: 'get',
  path: '/mentions/{id}',
  operationId: 'getMention',
  tags: ['Mentions'],
  security,
  request: { params: mentionParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: mentionSchema } }, description: 'The mention' },
    401: errorResponse('Missing or invalid API key'),
    404: errorResponse('Mention not found'),
  },
});

const setMentionStateRoute = createRoute({
  method: 'post',
  path: '/mentions/{id}/state',
  operationId: 'setMentionState',
  tags: ['Mentions'],
  security,
  request: {
    params: mentionParamsSchema,
    body: {
      content: {
        // Users may only park ('ignored') or close ('done') a mention; the
        // pipeline owns the other states.
        'application/json': { schema: z.object({ state: matchStateSchema.extract(['ignored', 'done']) }) },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: z.object({ id: z.string(), state: matchStateSchema }) },
      },
      description: 'State updated',
    },
    401: errorResponse('Missing or invalid API key'),
    404: errorResponse('Mention not found'),
  },
});

export const mentionsRouter = createRouter();

mentionsRouter.openapi(listMentionsRoute, async (c) => {
  const query = c.req.valid('query');
  try {
    const result = await searchMentions({ db: c.env.DB, orgId: c.get('orgId'), query });
    return c.json(result, 200);
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return c.json(errorBody('invalid_cursor', err.message), 400);
    }
    throw err;
  }
});

mentionsRouter.openapi(getMentionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const mention = await getMention({ db: c.env.DB, orgId: c.get('orgId'), mentionMatchId: id });
  if (!mention) {
    return c.json(errorBody('not_found', 'Mention not found'), 404);
  }
  return c.json(mention, 200);
});

mentionsRouter.openapi(setMentionStateRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { state } = c.req.valid('json');
  const updated = await setMentionState({ db: c.env.DB, orgId: c.get('orgId'), mentionMatchId: id, state });
  if (!updated) {
    return c.json(errorBody('not_found', 'Mention not found'), 404);
  }
  return c.json({ id, state }, 200);
});
