/**
 * mentions-api: REST skin over the @mentions/core ops layer. No product logic
 * here (invariant); handlers validate, call an op, shape the envelope.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth } from './auth';
import { getAuth } from './better-auth';
import { errorBody } from './errors';
import { createRouter } from './router';
import { apiKeysRouter } from './routes/api-keys';
import { billingRouter, registerPolarWebhook } from './routes/billing';
import { companyRouter } from './routes/company';
import { keywordsRouter } from './routes/keywords';
import { mentionsRouter } from './routes/mentions';
import { meRouter } from './routes/me';
import { onboardingRouter } from './routes/onboarding';
import { statsRouter } from './routes/stats';

const app = createRouter();

// Auth for everything under /v1 except health, the spec, and /v1/auth/*
// (all skipped inside the middleware).
app.use('/v1/*', auth);

// Better Auth owns /v1/auth/*: signup, login, OAuth callbacks, session.
app.on(['GET', 'POST'], '/v1/auth/*', (c) => getAuth(c.env).handler(c.req.raw));

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
v1.route('/', meRouter);
v1.route('/', onboardingRouter);
v1.route('/', statsRouter);
v1.route('/', billingRouter);
registerPolarWebhook(v1);

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
