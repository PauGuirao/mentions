/**
 * Thin Resend client (https://resend.com/docs/api-reference/emails/send-email).
 * Transport only, like polar.ts: callers own templates and decisions. Used by
 * the api worker for auth emails; the deliverer will reuse it when email
 * becomes a destination type.
 */

const SEND_URL = 'https://api.resend.com/emails';

export class ResendApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Resend send failed with ${status}: ${body.slice(0, 300)}`);
    this.name = 'ResendApiError';
  }
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class ResendClient {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey: string; from: string; fetchImpl?: typeof fetch }) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    // Wrapped, not assigned: calling a bare global fetch reference through a
    // property rebinds `this` and workerd throws "Illegal invocation".
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async send(args: SendEmailArgs): Promise<{ id: string }> {
    const response = await this.fetchImpl(SEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [args.to],
        subject: args.subject,
        text: args.text,
        ...(args.html ? { html: args.html } : {}),
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ResendApiError(response.status, text);
    }
    const parsed = JSON.parse(text) as { id?: unknown };
    return { id: typeof parsed.id === 'string' ? parsed.id : '' };
  }
}
