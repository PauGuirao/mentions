import { createRoute } from '@hono/zod-openapi';
import { applySubscriptionUpdate, getUsageSummary } from '@mentions/core/ops/billing';
import {
  PolarApiError,
  PolarClient,
  polarSubscriptionWebhookSchema,
  resolvePolarServer,
  verifyPolarWebhook,
} from '@mentions/core/polar';
import {
  billingCheckoutBodySchema,
  billingCheckoutResponseSchema,
  billingPortalResponseSchema,
  usageSummarySchema,
} from '@mentions/core/schemas';
import { errorBody, errorResponse } from '../errors';
import { createRouter } from '../router';
import type { AppEnv, Env } from '../types';

const security = [{ bearerAuth: [] }];

function polarClient(env: Env): PolarClient | null {
  if (!env.POLAR_ACCESS_TOKEN) return null;
  const server = resolvePolarServer(env.POLAR_SERVER);
  if (server === null) {
    console.error(`[billing] invalid POLAR_SERVER "${env.POLAR_SERVER}"; billing disabled`);
    return null;
  }
  return new PolarClient({ accessToken: env.POLAR_ACCESS_TOKEN, server });
}

/** Post-payment redirect targets: the app origins the deployment already
 *  trusts for auth. Empty allowlist (bare dev setup) -> https-only (schema). */
function isAllowedSuccessUrl(env: Env, successUrl: string): boolean {
  const allowed = (env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (env.BETTER_AUTH_URL) allowed.push(env.BETTER_AUTH_URL);
  if (allowed.length === 0) return true;
  try {
    const target = new URL(successUrl).origin;
    return allowed.some((origin) => new URL(origin).origin === target);
  } catch {
    return false;
  }
}

const checkoutRoute = createRoute({
  method: 'post',
  path: '/billing/checkout',
  operationId: 'createBillingCheckout',
  tags: ['Billing'],
  security,
  request: {
    body: { content: { 'application/json': { schema: billingCheckoutBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: billingCheckoutResponseSchema } },
      description: 'Hosted checkout URL for the subscription',
    },
    400: errorResponse('Invalid or disallowed successUrl'),
    401: errorResponse('Missing or invalid credentials'),
    503: errorResponse('Billing is not configured on this deployment'),
  },
});

const portalRoute = createRoute({
  method: 'post',
  path: '/billing/portal',
  operationId: 'createBillingPortalSession',
  tags: ['Billing'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: billingPortalResponseSchema } },
      description: 'Customer portal URL (manage subscription, view usage)',
    },
    401: errorResponse('Missing or invalid credentials'),
    404: errorResponse('No billing account yet; start a checkout first'),
    503: errorResponse('Billing is not configured on this deployment'),
  },
});

const usageRoute = createRoute({
  method: 'get',
  path: '/billing/usage',
  operationId: 'getBillingUsage',
  tags: ['Billing'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: usageSummarySchema } },
      description: 'Current-cycle usage and plan status',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

export const billingRouter = createRouter();

billingRouter.openapi(checkoutRoute, async (c) => {
  const polar = polarClient(c.env);
  if (!polar || !c.env.POLAR_PRODUCT_ID) {
    return c.json(errorBody('billing_not_configured', 'Billing is not configured'), 503);
  }
  const { successUrl } = c.req.valid('json');
  if (!isAllowedSuccessUrl(c.env, successUrl)) {
    return c.json(errorBody('validation_error', 'successUrl origin is not allowed'), 400);
  }
  const { url } = await polar.createCheckout({
    productId: c.env.POLAR_PRODUCT_ID,
    externalCustomerId: c.get('orgId'),
    successUrl,
  });
  return c.json({ url }, 200);
});

billingRouter.openapi(portalRoute, async (c) => {
  const polar = polarClient(c.env);
  if (!polar) {
    return c.json(errorBody('billing_not_configured', 'Billing is not configured'), 503);
  }
  try {
    const { url } = await polar.createPortalSession({ externalCustomerId: c.get('orgId') });
    return c.json({ url }, 200);
  } catch (err) {
    // Polar has no customer until the org's first checkout completes.
    if (err instanceof PolarApiError && (err.status === 404 || err.status === 422)) {
      return c.json(errorBody('not_found', 'No billing account yet; start a checkout first'), 404);
    }
    throw err;
  }
});

billingRouter.openapi(usageRoute, async (c) => {
  const summary = await getUsageSummary({ db: c.env.DB, orgId: c.get('orgId') });
  return c.json(summary, 200);
});

/** Plain (non-OpenAPI) route: Polar-facing, authenticated by HMAC signature
 *  over the RAW body, so it must not go through body-parsing validation. */
export function registerPolarWebhook(app: ReturnType<typeof createRouter>): void {
  app.post('/webhooks/polar', async (c) => {
    const secret = c.env.POLAR_WEBHOOK_SECRET;
    if (!secret) {
      return c.json(errorBody('billing_not_configured', 'Billing is not configured'), 503);
    }

    const payload = await c.req.raw.text();
    const valid = await verifyPolarWebhook({
      payload,
      headers: {
        id: c.req.header('webhook-id') ?? null,
        timestamp: c.req.header('webhook-timestamp') ?? null,
        signature: c.req.header('webhook-signature') ?? null,
      },
      secret,
      nowMs: Date.now(),
    });
    if (!valid) {
      return c.json(errorBody('invalid_signature', 'Webhook signature verification failed'), 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      // Signature-valid but unparseable; retrying cannot help, so acknowledge.
      return c.json({ received: true }, 202);
    }
    const parsed = polarSubscriptionWebhookSchema.safeParse(body);
    // Not a subscription event (or a shape we don't track): acknowledge so
    // Polar stops retrying; billing only reacts to subscription lifecycle.
    if (!parsed.success) {
      return c.json({ received: true }, 202);
    }

    const { data } = parsed.data;
    const orgId = data.customer?.external_id;
    if (!orgId) {
      console.warn('[billing] subscription webhook without external customer id', { type: parsed.data.type });
      return c.json({ received: true }, 202);
    }

    const toEpoch = (value: string | null | undefined): number | null => {
      if (!value) return null;
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    };

    await applySubscriptionUpdate({
      db: c.env.DB,
      orgId,
      polarCustomerId: data.customer?.id ?? data.customer_id ?? '',
      polarSubscriptionId: data.id,
      polarStatus: data.status,
      currentPeriodStart: toEpoch(data.current_period_start),
      currentPeriodEnd: toEpoch(data.current_period_end),
    });
    return c.json({ received: true }, 200);
  });
}
