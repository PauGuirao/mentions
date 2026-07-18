export interface Env {
  DB: D1Database;
  KV: KVNamespace;
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
}

/** Hono generics: bindings + per-request variables set by the auth middleware.
 *  orgId is always set past auth; userId only when the caller used a session
 *  token (humans) rather than an API key (machines). */
export type AppEnv = {
  Bindings: Env;
  Variables: { orgId: string; userId?: string };
};
