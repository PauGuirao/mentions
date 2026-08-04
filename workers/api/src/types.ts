import type { EvlogVariables } from 'evlog/hono';

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /** Workers AI, used by onboarding website analysis. */
  AI: Ai;
  /** Public origin auth redirects resolve against (basePath /v1/auth). */
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  /** Google sign-in switches on when both are set (secret put, no deploy). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Comma-separated extra origins allowed to hit auth (dev SPA, previews). */
  TRUSTED_ORIGINS?: string;
  /** Better Auth hosted dashboard (Infra) key; dash plugin off when unset. */
  BETTER_AUTH_API_KEY?: string;
  /** Billing switches on when all three are set (secret put, no deploy). */
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  /** Polar product carrying the keyword + mention metered prices. */
  POLAR_PRODUCT_ID?: string;
  /** 'sandbox' (default) or 'production'. */
  POLAR_SERVER?: string;
  /** Slack integration switches on when both are set (secret put, no deploy).
   *  The Slack app's redirect URL must list <api-origin>/v1/slack/callback. */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Auth emails (password reset, signup verification) switch on when set;
   *  the sending domain must be verified in Resend. */
  RESEND_API_KEY?: string;
  /** Defaults to 'Mentio <notifications@mentio.dev>'. */
  EMAIL_FROM?: string;
  /** Axiom wide-event drain switches on when both are set. */
  AXIOM_API_KEY?: string;
  AXIOM_DATASET?: string;
}

/** Hono generics: bindings + per-request variables set by the auth middleware.
 *  orgId is always set past auth; userId only when the caller used a session
 *  token (humans) rather than an API key (machines). */
export type AppEnv = {
  Bindings: Env;
  Variables: { orgId: string; userId?: string } & EvlogVariables['Variables'];
};
