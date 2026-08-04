/**
 * Thin Polar API client (https://polar.sh/docs/api-reference). Transport
 * only: no product logic, no D1. Ops in ops/billing.ts decide WHAT to send;
 * this file decides HOW.
 *
 * - Usage events go to POST /v1/events/ingest. Polar dedupes on our
 *   `external_id`, which is what makes the billing flush safely re-runnable.
 * - Webhooks follow the Standard Webhooks spec (HMAC-SHA256 over
 *   "{id}.{timestamp}.{payload}", base64 secret, `webhook-*` headers).
 */
import { z } from 'zod';

const SERVERS = {
  production: 'https://api.polar.sh',
  sandbox: 'https://sandbox-api.polar.sh',
} as const;

export type PolarServer = keyof typeof SERVERS;

/** Strict env parsing: anything but the two known values returns null so
 *  callers fail loudly instead of silently talking to the wrong API (a
 *  'prod' typo must not send production traffic to sandbox). */
export function resolvePolarServer(value: string | undefined): PolarServer | null {
  if (value === 'production' || value === 'sandbox') return value;
  if (value === undefined) return 'sandbox';
  return null;
}

export interface PolarEvent {
  name: string;
  /** Our org id; Polar maps it to the customer created at checkout. */
  externalCustomerId: string;
  /** Deduplication key. Same external_id -> counted once, ever. */
  externalId: string;
  metadata?: Record<string, string | number | boolean>;
}

const ingestResponseSchema = z.object({
  inserted: z.number().int(),
  duplicates: z.number().int().default(0),
});
export type IngestResult = z.infer<typeof ingestResponseSchema>;

const checkoutResponseSchema = z.object({ url: z.string() });

const customerSessionResponseSchema = z.object({ customer_portal_url: z.string() });

export class PolarApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    body: string,
  ) {
    super(`Polar ${endpoint} failed with ${status}: ${body.slice(0, 300)}`);
    this.name = 'PolarApiError';
  }
}

export interface PolarClientOptions {
  accessToken: string;
  server: PolarServer;
  fetchImpl?: typeof fetch;
}

export class PolarClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PolarClientOptions) {
    this.baseUrl = SERVERS[options.server];
    this.accessToken = options.accessToken;
    // Wrapped, not assigned: calling a bare global fetch reference through a
    // property rebinds `this` and workerd throws "Illegal invocation".
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new PolarApiError(response.status, path, text);
    }
    return schema.parse(JSON.parse(text));
  }

  async ingestEvents(events: PolarEvent[]): Promise<IngestResult> {
    if (events.length === 0) return { inserted: 0, duplicates: 0 };
    return this.post(
      '/v1/events/ingest',
      {
        events: events.map((event) => ({
          name: event.name,
          external_customer_id: event.externalCustomerId,
          external_id: event.externalId,
          metadata: event.metadata ?? {},
        })),
      },
      ingestResponseSchema,
    );
  }

  /** Hosted checkout for the subscription product; Polar creates (or reuses)
   *  the customer keyed by external_customer_id. */
  async createCheckout(args: {
    productId: string;
    externalCustomerId: string;
    successUrl: string;
  }): Promise<{ url: string }> {
    return this.post(
      '/v1/checkouts',
      {
        products: [args.productId],
        external_customer_id: args.externalCustomerId,
        success_url: args.successUrl,
      },
      checkoutResponseSchema,
    );
  }

  /** Customer portal session (manage/cancel subscription, view usage). */
  async createPortalSession(args: { externalCustomerId: string }): Promise<{ url: string }> {
    const session = await this.post(
      '/v1/customer-sessions',
      { external_customer_id: args.externalCustomerId },
      customerSessionResponseSchema,
    );
    return { url: session.customer_portal_url };
  }
}

const HMAC_KEY_PARAMS = { name: 'HMAC', hash: 'SHA-256' } as const;
/** Standard Webhooks default tolerance. */
const TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Candidate HMAC keys for one configured secret. Standard Webhooks says the
 * part after "whsec_" is base64 and the key is its decoded bytes, but Polar
 * signs with the raw utf8 bytes of the secret string (their docs wrap the
 * secret in btoa() before handing it to the standardwebhooks lib). Accepting
 * every derivation of the same shared secret keeps verification strict
 * (an attacker without the secret can produce none of them) while working
 * with both interpretations.
 */
function candidateKeys(secret: string): Array<Uint8Array<ArrayBuffer>> {
  const suffix = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const keys: Array<Uint8Array<ArrayBuffer>> = [];
  try {
    keys.push(base64ToBytes(suffix));
  } catch {
    // Not base64; the utf8 candidates below cover it.
  }
  keys.push(new TextEncoder().encode(suffix));
  keys.push(new TextEncoder().encode(secret));
  return keys;
}

/**
 * Verify a Polar webhook request. Returns true only when a `v1` signature
 * matches AND the timestamp is within tolerance. Callers must read the raw
 * body BEFORE json-parsing: the signature covers the exact bytes.
 */
export async function verifyPolarWebhook(args: {
  payload: string;
  headers: { id: string | null; timestamp: string | null; signature: string | null };
  secret: string;
  nowMs: number;
}): Promise<boolean> {
  const { payload, headers, secret, nowMs } = args;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const timestampMs = Number(headers.timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > TIMESTAMP_TOLERANCE_MS) {
    return false;
  }

  const signedContent = new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${payload}`);
  // Header carries space-separated "v1,<sig>" entries (key rotation).
  const provided = headers.signature
    .split(' ')
    .map((part) => (part.startsWith('v1,') ? part.slice('v1,'.length) : part));

  for (const keyBytes of candidateKeys(secret)) {
    const key = await crypto.subtle.importKey('raw', keyBytes, HMAC_KEY_PARAMS, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, signedContent);
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if (provided.some((part) => constantTimeEqual(part, expected))) return true;
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The webhook payload slice billing cares about; everything else is ignored
 *  by the handler (202). */
export const polarSubscriptionWebhookSchema = z.object({
  type: z.enum([
    'subscription.created',
    'subscription.updated',
    'subscription.active',
    'subscription.canceled',
    'subscription.revoked',
  ]),
  data: z.object({
    id: z.string(),
    status: z.string(),
    customer_id: z.string().optional(),
    current_period_start: z.string().nullable().optional(),
    current_period_end: z.string().nullable().optional(),
    customer: z
      .object({
        id: z.string(),
        external_id: z.string().nullable().optional(),
      })
      .optional(),
  }),
});
export type PolarSubscriptionWebhook = z.infer<typeof polarSubscriptionWebhookSchema>;
