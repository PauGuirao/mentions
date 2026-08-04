import { describe, expect, it } from 'vitest';
import { ResendApiError, ResendClient } from './email';

function stubFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('ResendClient.send', () => {
  it('posts the from/to/subject/text wire shape with bearer auth', async () => {
    const { fetchImpl, calls } = stubFetch(200, { id: 'email_1' });
    const client = new ResendClient({ apiKey: 're_key', from: 'Mentio <n@mentio.dev>', fetchImpl });

    const result = await client.send({ to: 'user@example.com', subject: 'Hello', text: 'Body' });

    expect(result).toEqual({ id: 'email_1' });
    const sent = JSON.parse(String(calls[0]!.body));
    expect(sent).toEqual({
      from: 'Mentio <n@mentio.dev>',
      to: ['user@example.com'],
      subject: 'Hello',
      text: 'Body',
    });
    expect(new Headers(calls[0]!.headers).get('authorization')).toBe('Bearer re_key');
  });

  it('includes html only when provided', async () => {
    const { fetchImpl, calls } = stubFetch(200, { id: 'email_2' });
    const client = new ResendClient({ apiKey: 'k', from: 'f@x.dev', fetchImpl });
    await client.send({ to: 't@x.dev', subject: 's', text: 't', html: '<p>t</p>' });
    expect(JSON.parse(String(calls[0]!.body)).html).toBe('<p>t</p>');
  });

  it('throws ResendApiError on a non-2xx response', async () => {
    const { fetchImpl } = stubFetch(422, { message: 'domain not verified' });
    const client = new ResendClient({ apiKey: 'k', from: 'f@x.dev', fetchImpl });
    await expect(client.send({ to: 't@x.dev', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      ResendApiError,
    );
  });
});
