export interface Env {
  DB: D1Database;
  KV: KVNamespace;
}

/** Hono generics: bindings + per-request variables set by the auth middleware. */
export type AppEnv = {
  Bindings: Env;
  Variables: { orgId: string };
};
