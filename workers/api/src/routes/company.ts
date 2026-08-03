import { createRoute } from '@hono/zod-openapi';
import {
  getCompanyContext,
  getCompanyProfile,
  setCompanyContext,
  setCompanyProfile,
} from '@mentions/core/ops/company';
import { companyContextBodySchema, companyProfileSchema } from '@mentions/core/schemas';
import { errorBody, errorResponse } from '../errors';
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

const getProfileRoute = createRoute({
  method: 'get',
  path: '/company/profile',
  operationId: 'getCompanyProfile',
  tags: ['Company'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: companyProfileSchema } },
      description: 'Structured company profile (classifier context is composed from it)',
    },
    401: errorResponse('Missing or invalid API key'),
    404: errorResponse('Org not found'),
  },
});

const putProfileRoute = createRoute({
  method: 'put',
  path: '/company/profile',
  operationId: 'setCompanyProfile',
  tags: ['Company'],
  security,
  request: {
    body: { content: { 'application/json': { schema: companyProfileSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: companyProfileSchema } },
      description: 'The saved company profile',
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

companyRouter.openapi(getProfileRoute, async (c) => {
  const profile = await getCompanyProfile({ db: c.env.DB, orgId: c.get('orgId') });
  if (!profile) {
    return c.json(errorBody('not_found', 'Org not found'), 404);
  }
  return c.json(profile, 200);
});

companyRouter.openapi(putProfileRoute, async (c) => {
  const profile = c.req.valid('json');
  await setCompanyProfile({ db: c.env.DB, orgId: c.get('orgId'), profile });
  return c.json(profile, 200);
});
