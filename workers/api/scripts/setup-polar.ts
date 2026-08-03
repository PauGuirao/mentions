/**
 * One-shot Polar environment setup via the REST API (no dashboard clicking):
 * creates the two usage meters the billing code emits (see
 * packages/core/src/ops/billing.ts), the monthly EUR subscription product with
 * both metered prices, and the webhook endpoint. Idempotent: existing
 * resources are matched by name/URL and reused, never duplicated.
 *
 * Usage (from workers/api):
 *   POLAR_ACCESS_TOKEN=polar_oat_... pnpm exec tsx scripts/setup-polar.ts [--production] [--webhook-url <url>]
 * The token is read from the environment first, then from .dev.vars.
 * Prints POLAR_PRODUCT_ID and the webhook secret for `wrangler secret put`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVERS = {
  sandbox: 'https://sandbox-api.polar.sh',
  production: 'https://api.polar.sh',
} as const;

const PRODUCT_NAME = 'Mentions Pro';
const WEBHOOK_EVENTS = [
  'subscription.created',
  'subscription.updated',
  'subscription.active',
  'subscription.canceled',
  'subscription.revoked',
];
/** Cents. keyword_days: EUR 5 per keyword-month prorated daily (5/30). */
const KEYWORD_DAY_UNIT_AMOUNT = '16.6667';
const MENTION_UNIT_AMOUNT = 500;

const args = process.argv.slice(2);
const server: keyof typeof SERVERS = args.includes('--production') ? 'production' : 'sandbox';
const webhookArg = args.indexOf('--webhook-url');
const webhookUrl =
  webhookArg !== -1 && args[webhookArg + 1]
    ? args[webhookArg + 1]
    : 'https://mentions-api.guiraocastells.workers.dev/v1/webhooks/polar';

function tokenFromDevVars(): string | null {
  try {
    const devVars = readFileSync(fileURLToPath(new URL('../.dev.vars', import.meta.url)), 'utf8');
    const line = devVars.split('\n').find((l) => l.startsWith('POLAR_ACCESS_TOKEN='));
    return line?.slice('POLAR_ACCESS_TOKEN='.length).trim().replace(/^["']|["']$/g, '') ?? null;
  } catch {
    return null;
  }
}

const token = process.env['POLAR_ACCESS_TOKEN'] ?? tokenFromDevVars();
if (!token) {
  console.error(
    'No POLAR_ACCESS_TOKEN. Create an organization access token in the Polar dashboard\n' +
      `(${server === 'sandbox' ? 'https://sandbox.polar.sh' : 'https://polar.sh'} -> Settings -> Developers)\n` +
      'and either export it or add POLAR_ACCESS_TOKEN=... to workers/api/.dev.vars',
  );
  process.exit(1);
}

const base = SERVERS[server];

async function polar<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
  }
  return JSON.parse(text) as T;
}

interface Page<T> {
  items: T[];
}
interface Meter {
  id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
  is_archived: boolean;
  prices: Array<{ amount_type: string; unit_amount?: number | string }>;
}
interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  events: string[];
}

async function ensureMeter(name: string, eventName: string, aggregation: object): Promise<Meter> {
  const existing = await polar<Page<Meter>>('GET', `/v1/meters?query=${encodeURIComponent(name)}`);
  const match = existing.items.find((m) => m.name === name);
  if (match) {
    console.log(`meter "${name}" already exists: ${match.id}`);
    return match;
  }
  const meter = await polar<Meter>('POST', '/v1/meters', {
    name,
    filter: {
      conjunction: 'and',
      clauses: [{ property: 'name', operator: 'eq', value: eventName }],
    },
    aggregation,
  });
  console.log(`created meter "${name}": ${meter.id}`);
  return meter;
}

async function main(): Promise<void> {
  console.log(`Polar setup against ${server} (${base})\n`);

  const keywordMeter = await ensureMeter('Keyword days', 'keyword_days', {
    func: 'sum',
    property: 'count',
  });
  const mentionMeter = await ensureMeter('Mention units', 'mention_units', { func: 'count' });

  const products = await polar<Page<Product>>(
    'GET',
    `/v1/products?is_archived=false&query=${encodeURIComponent(PRODUCT_NAME)}`,
  );
  let product = products.items.find((p) => p.name === PRODUCT_NAME);
  if (product) {
    console.log(`product "${PRODUCT_NAME}" already exists: ${product.id}`);
  } else {
    product = await polar<Product>('POST', '/v1/products', {
      name: PRODUCT_NAME,
      description:
        'Usage-based plan: EUR 5 per keyword-month (prorated daily) and EUR 5 per 1,000 relevant mentions past the pooled allowance.',
      recurring_interval: 'month',
      prices: [
        {
          amount_type: 'metered_unit',
          price_currency: 'eur',
          meter_id: keywordMeter.id,
          unit_amount: KEYWORD_DAY_UNIT_AMOUNT,
        },
        {
          amount_type: 'metered_unit',
          price_currency: 'eur',
          meter_id: mentionMeter.id,
          unit_amount: MENTION_UNIT_AMOUNT,
        },
      ],
    });
    console.log(`created product "${PRODUCT_NAME}": ${product.id}`);
    console.log('  prices:', JSON.stringify(product.prices, null, 2));
  }

  const endpoints = await polar<Page<WebhookEndpoint>>('GET', '/v1/webhooks/endpoints');
  let endpoint = endpoints.items.find((e) => e.url === webhookUrl);
  if (endpoint) {
    console.log(`webhook endpoint already exists: ${endpoint.id} (${endpoint.url})`);
  } else {
    endpoint = await polar<WebhookEndpoint>('POST', '/v1/webhooks/endpoints', {
      url: webhookUrl,
      format: 'raw',
      events: WEBHOOK_EVENTS,
      name: 'mentions-api billing',
    });
    console.log(`created webhook endpoint: ${endpoint.id} (${endpoint.url})`);
  }

  console.log('\n--- Secrets to set ---');
  console.log(`POLAR_SERVER=${server}`);
  console.log(`POLAR_PRODUCT_ID=${product.id}`);
  console.log(`POLAR_WEBHOOK_SECRET=${endpoint.secret ?? '(shown once at creation; rotate in dashboard if lost)'}`);
  console.log('\nwrangler secret put POLAR_ACCESS_TOKEN   (api + scheduler)');
  console.log('wrangler secret put POLAR_WEBHOOK_SECRET (api)');
  console.log('wrangler secret put POLAR_PRODUCT_ID     (api)');
  console.log('\nVerify in the dashboard that the keyword-day price reads as ~EUR 0.17/unit;');
  console.log('if it shows EUR 16.67, unit_amount is euros there, so divide by 100 and re-run.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
