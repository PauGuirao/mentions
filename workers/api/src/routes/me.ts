import { createRoute } from '@hono/zod-openapi';
import { getUserWithOrgs } from '@mentions/core/ops/org-members';
import { meResponseSchema } from '@mentions/core/schemas';
import { errorBody, errorResponse } from '../errors';
import { createRouter } from '../router';

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  operationId: 'getMe',
  tags: ['Auth'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: meResponseSchema } },
      description: 'The authenticated user and their workspaces',
    },
    401: errorResponse('Session required (API keys carry no user identity)'),
  },
});

export const meRouter = createRouter();

meRouter.openapi(meRoute, async (c) => {
  const userId = c.get('userId');
  if (!userId) {
    return c.json(errorBody('unauthorized', 'Session required'), 401);
  }
  const me = await getUserWithOrgs({ db: c.env.DB, userId });
  if (!me) {
    return c.json(errorBody('unauthorized', 'User no longer exists'), 401);
  }
  return c.json(me, 200);
});
