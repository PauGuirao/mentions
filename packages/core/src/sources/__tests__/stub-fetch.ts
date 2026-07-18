/** Network-free fetch stub for adapter tests: replays canned payloads
 *  (one per call; the last one repeats) and records every request. Objects
 *  are served as JSON; STRING payloads are served raw (for XML feeds). */

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
    if (typeof current === 'string') {
      return new Response(current, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      });
    }
    return new Response(JSON.stringify(current), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetchImpl, requests };
}
