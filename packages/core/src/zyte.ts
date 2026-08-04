/**
 * Zyte API transport (https://docs.zyte.com/zyte-api/get-started.html). Fetches
 * a URL through Zyte's proxy network with browser-grade TLS, which is what
 * makes Reddit's public JSON endpoints reachable from Workers at all (their
 * edge 403s any datacenter IP / non-browser TLS handshake, verified 2026-08).
 *
 * Transport only, no product logic: adapters decide WHAT to request and how to
 * parse it. We always use httpResponseBody (the cheap tier — reddit.com is
 * "moderate"/tier 3, roughly USD 0.5/1k requests); browser rendering costs
 * ~10x and buys nothing for JSON endpoints.
 *
 * Billing note: Zyte charges per SUCCESSFUL response, so a block or a 5xx is
 * free. That is why transient failures throw and let the ingest queue retry.
 */
import { z } from 'zod';

const ZYTE_ENDPOINT = 'https://api.zyte.com/v1/extract';
/** Zyte holds the connection while it retries upstream; keep well above a
 *  normal fetch timeout but below the queue consumer's patience. */
const REQUEST_TIMEOUT_MS = 60_000;

const extractResponseSchema = z.object({
  /** base64 of the raw upstream body. */
  httpResponseBody: z.string(),
  statusCode: z.number().int().optional(),
});

export class ZyteError extends Error {
  /** Retryable: Zyte-side throttling/outage or an upstream 5xx. */
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'ZyteError';
    this.transient = transient;
  }
}

const decodeBase64 = (b64: string): string => {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/**
 * Fetch `url` through Zyte and return the upstream response body as text.
 * Throws ZyteError; callers map transient=true onto their retry path.
 */
export async function zyteFetchText(args: {
  apiKey: string;
  url: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const doFetch = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(ZYTE_ENDPOINT, {
      method: 'POST',
      headers: {
        // Zyte uses HTTP Basic with the API key as the username, no password.
        Authorization: `Basic ${btoa(`${args.apiKey}:`)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: args.url, httpResponseBody: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ZyteError(
      `zyte: request failed (${err instanceof Error ? err.message : String(err)})`,
      true,
    );
  }

  if (!response.ok) {
    // 429/5xx clear up on their own; 401/403 (bad key) and 422 (bad request)
    // need a config fix, so retrying would just burn queue attempts.
    const transient = response.status === 429 || response.status >= 500;
    throw new ZyteError(`zyte: responded ${response.status}`, transient);
  }

  let parsed: z.infer<typeof extractResponseSchema>;
  try {
    parsed = extractResponseSchema.parse(await response.json());
  } catch {
    throw new ZyteError('zyte: unexpected response shape', true);
  }

  // Zyte returns 200 with the upstream status inside; an upstream 4xx here
  // means the target blocked us despite the proxy (not retryable in place).
  if (parsed.statusCode !== undefined && parsed.statusCode >= 400) {
    throw new ZyteError(
      `zyte: upstream responded ${parsed.statusCode}`,
      parsed.statusCode >= 500,
    );
  }

  return decodeBase64(parsed.httpResponseBody);
}
