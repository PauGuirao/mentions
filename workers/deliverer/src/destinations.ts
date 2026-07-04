/**
 * Destination transports: webhook (signed JSON POST) and Slack
 * (chat.postMessage). Each send resolves to an Outcome; the consumer in
 * index.ts owns the deliveries bookkeeping and retry decision.
 */
import type { z } from 'zod';
import type { destinationConfigSchema, Mention } from '@mentions/core/schemas';

export type DestinationConfig = z.infer<typeof destinationConfigSchema>;

export type SendOutcome =
  | { ok: true }
  /** transient: worth another attempt (network, timeout, 429, 5xx). */
  | { ok: false; transient: boolean; error: string };

const SEND_TIMEOUT_MS = 10_000;

const transientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sendWebhook(args: {
  url: string;
  secret: string;
  mention: Mention;
}): Promise<SendOutcome> {
  const body = JSON.stringify({ event: 'mention.matched', mention: args.mention });
  const signature = await hmacSha256Hex(args.secret, body);

  let response: Response;
  try {
    response = await fetch(args.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Mentions-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or the 10s timeout: always worth another attempt.
    return { ok: false, transient: true, error: err instanceof Error ? err.message : String(err) };
  }

  if (response.ok) return { ok: true };
  return {
    ok: false,
    transient: transientStatus(response.status),
    error: `webhook responded ${response.status}`,
  };
}

/** Compact, plain-text summary for Slack: term, source, note, url. */
export function buildSlackText(mention: Mention): string {
  const lines = [`New mention of "${mention.keywordTerm}" on ${mention.source}`];
  if (mention.aiNote) lines.push(mention.aiNote);
  lines.push(mention.url);
  return lines.join('\n');
}

/** Slack errors that clear up on their own; everything else (bad channel,
 *  revoked token, ...) needs a config fix, not a retry. */
const SLACK_TRANSIENT_ERRORS = new Set([
  'ratelimited',
  'rate_limited',
  'internal_error',
  'service_unavailable',
  'request_timeout',
  'fatal_error',
]);

export async function sendSlack(args: {
  botToken: string;
  channel: string;
  mention: Mention;
}): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${args.botToken}`,
      },
      body: JSON.stringify({ channel: args.channel, text: buildSlackText(args.mention) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, transient: true, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    return {
      ok: false,
      transient: transientStatus(response.status),
      error: `slack responded ${response.status}`,
    };
  }

  // Slack signals most failures as 200 + { ok: false, error }.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, transient: true, error: 'slack returned non-JSON body' };
  }
  const result = payload as { ok?: unknown; error?: unknown };
  if (result.ok === true) return { ok: true };

  const slackError = typeof result.error === 'string' ? result.error : 'unknown_error';
  return {
    ok: false,
    transient: SLACK_TRANSIENT_ERRORS.has(slackError),
    error: `slack error: ${slackError}`,
  };
}

export async function sendToDestination(args: {
  config: DestinationConfig;
  mention: Mention;
}): Promise<SendOutcome> {
  const { config, mention } = args;
  switch (config.type) {
    case 'webhook':
      return sendWebhook({ url: config.url, secret: config.secret, mention });
    case 'slack':
      return sendSlack({ botToken: config.botToken, channel: config.channel, mention });
  }
}
