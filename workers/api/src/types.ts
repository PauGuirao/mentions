export interface Env {
  DB: D1Database;
  KV: KVNamespace;
}

/** Hono generics: bindings + per-request variables set by the auth middleware.
 *  orgId is always set past auth; userId only when the caller used a session
 *  token (humans) rather than an API key (machines). */
export type AppEnv = {
  Bindings: Env;
  Variables: { orgId: string; userId?: string };
};
