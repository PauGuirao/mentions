import { describe, expect, it } from 'vitest';
import { PolarApiError, PolarClient, verifyPolarWebhook } from './polar';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('PolarClient.ingestEvents', () => {
  it('maps events to the snake_case wire shape', async () => {
    const { fetchImpl, calls } = stubFetch(200, { inserted: 1, duplicates: 0 });
    const client = new PolarClient({ accessToken: 'tok', server: 'sandbox', fetchImpl });

    const result = await client.ingestEvents([
      { name: 'mention_units', externalCustomerId: 'org_1', externalId: 'munit:org_1:2026-08:1', metadata: { unit: 1 } },
    ]);

    expect(result).toEqual({ inserted: 1, duplicates: 0 });
    expect(calls[0]!.url).toBe('https://sandbox-api.polar.sh/v1/events/ingest');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.events[0]).toEqual({
      name: 'mention_units',
      external_customer_id: 'org_1',
      external_id: 'munit:org_1:2026-08:1',
      metadata: { unit: 1 },
    });
  });

  it('short-circuits an empty batch without a request', async () => {
    const { fetchImpl, calls } = stubFetch(200, {});
    const client = new PolarClient({ accessToken: 'tok', server: 'sandbox', fetchImpl });
    expect(await client.ingestEvents([])).toEqual({ inserted: 0, duplicates: 0 });
    expect(calls).toHaveLength(0);
  });

  it('throws PolarApiError on a non-2xx response', async () => {
    const { fetchImpl } = stubFetch(422, { error: 'bad' });
    const client = new PolarClient({ accessToken: 'tok', server: 'sandbox', fetchImpl });
    await expect(
      client.ingestEvents([{ name: 'x', externalCustomerId: 'o', externalId: 'e' }]),
    ).rejects.toBeInstanceOf(PolarApiError);
  });
});

describe('PolarClient.createCheckout', () => {
  it('posts the product, external customer and success url', async () => {
    const { fetchImpl, calls } = stubFetch(201, { url: 'https://polar.sh/checkout/abc' });
    const client = new PolarClient({ accessToken: 'tok', server: 'production', fetchImpl });

    const { url } = await client.createCheckout({
      productId: 'prod_1',
      externalCustomerId: 'org_1',
      successUrl: 'https://app.example/billing/done',
    });

    expect(url).toBe('https://polar.sh/checkout/abc');
    expect(calls[0]!.url).toBe('https://api.polar.sh/v1/checkouts');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      products: ['prod_1'],
      external_customer_id: 'org_1',
      success_url: 'https://app.example/billing/done',
    });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer tok');
  });
});

const SECRET_BYTES = new TextEncoder().encode('super-secret-key');
const SECRET_B64 = btoa(String.fromCharCode(...SECRET_BYTES));

async function sign(id: string, timestamp: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', SECRET_BYTES, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

describe('verifyPolarWebhook', () => {
  const payload = '{"type":"subscription.created"}';
  const nowMs = 1_800_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));

  it('accepts a valid v1 signature within tolerance', async () => {
    const signature = await sign('msg_1', timestamp, payload);
    expect(
      await verifyPolarWebhook({
        payload,
        headers: { id: 'msg_1', timestamp, signature: `v1,${signature}` },
        secret: `whsec_${SECRET_B64}`,
        nowMs,
      }),
    ).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const signature = await sign('msg_1', timestamp, payload);
    expect(
      await verifyPolarWebhook({
        payload: '{"type":"subscription.canceled"}',
        headers: { id: 'msg_1', timestamp, signature: `v1,${signature}` },
        secret: `whsec_${SECRET_B64}`,
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects a stale timestamp even with a valid signature', async () => {
    const staleTimestamp = String(Math.floor((nowMs - 10 * 60_000) / 1000));
    const signature = await sign('msg_1', staleTimestamp, payload);
    expect(
      await verifyPolarWebhook({
        payload,
        headers: { id: 'msg_1', timestamp: staleTimestamp, signature: `v1,${signature}` },
        secret: `whsec_${SECRET_B64}`,
        nowMs,
      }),
    ).toBe(false);
  });

  it('rejects missing headers', async () => {
    expect(
      await verifyPolarWebhook({
        payload,
        headers: { id: null, timestamp, signature: 'v1,abc' },
        secret: SECRET_B64,
        nowMs,
      }),
    ).toBe(false);
  });
});
