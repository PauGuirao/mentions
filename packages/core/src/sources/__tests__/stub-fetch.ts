/** Network-free fetch stub for adapter tests: replays canned JSON payloads
 *  (one per call; the last one repeats) and records every request. */

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

export function stubFetch({ responses }: { responses: unknown[] }): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const remaining = [...responses];
  let current: unknown = null;
  const requests: RecordedRequest[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = input instanceof Request ? input.headers : init?.headers;
    if (rawHeaders) {
      new Headers(rawHeaders).forEach((value, key) => {
        headers[key] = value;
      });
    }
    requests.push({ url, headers });

    if (remaining.length > 0) current = remaining.shift() ?? null;
    return new Response(JSON.stringify(current), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetchImpl, requests };
}
