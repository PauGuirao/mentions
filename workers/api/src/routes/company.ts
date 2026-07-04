import { createRoute } from '@hono/zod-openapi';
import { getCompanyContext, setCompanyContext } from '@mentions/core/ops/company';
import { companyContextBodySchema } from '@mentions/core/schemas';
import { errorResponse } from '../errors';
import { createRouter } from '../router';

const security = [{ bearerAuth: [] }];

const getCompanyRoute = createRoute({
  method: 'get',
  path: '/company',
  operationId: 'getCompanyContext',
  tags: ['Company'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: companyContextBodySchema } },
      description: 'Free-text company context fed to the classifier',
    },
    401: errorResponse('Missing or invalid API key'),
  },
});

const putCompanyRoute = createRoute({
  method: 'put',
  path: '/company',
  operationId: 'setCompanyContext',
  tags: ['Company'],
  security,
  request: {
    body: { content: { 'application/json': { schema: companyContextBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: companyContextBodySchema } },
      description: 'The saved company context',
    },
    401: errorResponse('Missing or invalid API key'),
  },
});

export const companyRouter = createRouter();

companyRouter.openapi(getCompanyRoute, async (c) => {
  const context = await getCompanyContext({ db: c.env.DB, orgId: c.get('orgId') });
  return c.json({ context }, 200);
});

companyRouter.openapi(putCompanyRoute, async (c) => {
  const { context } = c.req.valid('json');
  await setCompanyContext({ db: c.env.DB, orgId: c.get('orgId'), context });
  return c.json({ context }, 200);
});
