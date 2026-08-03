import { createRoute } from '@hono/zod-openapi';
import { getMentionStats } from '@mentions/core/ops/stats';
import { mentionStatsQuerySchema, mentionStatsSchema } from '@mentions/core/schemas';
import { errorResponse } from '../errors';
import { createRouter } from '../router';

const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  operationId: 'getMentionStats',
  tags: ['Mentions'],
  security: [{ bearerAuth: [] }],
  request: { query: mentionStatsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: mentionStatsSchema } },
      description: 'Mention aggregates for the window: daily series, sentiment, sources, keywords',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

export const statsRouter = createRouter();

statsRouter.openapi(statsRoute, async (c) => {
  const { sinceDays, source, keywordId } = c.req.valid('query');
  const stats = await getMentionStats({
    db: c.env.DB,
    orgId: c.get('orgId'),
    sinceDays,
    source,
    keywordId,
  });
  return c.json(stats, 200);
});
