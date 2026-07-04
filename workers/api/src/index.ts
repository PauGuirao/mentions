/**
 * mentions-api: REST skin over the @mentions/core ops layer. No product logic
 * here (invariant); handlers validate, call an op, shape the envelope.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth } from './auth';
import { errorBody } from './errors';
import { createRouter } from './router';
import { apiKeysRouter } from './routes/api-keys';
import { companyRouter } from './routes/company';
import { keywordsRouter } from './routes/keywords';
import { mentionsRouter } from './routes/mentions';

const app = createRouter();

// Auth for everything under /v1 except health and the spec (skipped inside).
app.use('/v1/*', auth);

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  operationId: 'getHealth',
  tags: ['System'],
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
      description: 'API is up',
    },
  },
});

const v1 = createRouter();
v1.openapi(healthRoute, (c) => c.json({ ok: true }, 200));
v1.route('/', keywordsRouter);
v1.route('/', mentionsRouter);
v1.route('/', companyRouter);
v1.route('/', apiKeysRouter);

app.route('/v1', v1);

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'API key minted via POST /v1/api-keys (format mk_live_...)',
});

app.doc('/v1/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Mentions API',
    version: '0.0.1',
    description: 'Keyword and brand mention tracking across dev platforms.',
  },
});

app.notFound((c) => c.json(errorBody('not_found', 'Route not found'), 404));

app.onError((err, c) => {
  console.error('[mentions-api] unhandled error', err);
  return c.json(errorBody('internal_error', 'Unexpected error'), 500);
});

export default app;
