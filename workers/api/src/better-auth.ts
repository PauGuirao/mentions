/**
 * Better Auth instance, one per isolate (lazy; Workers env is only available
 * at request time). Identity lives in Better Auth's own tables (user,
 * session, account, verification — migration 0003); tenancy stays in core:
 * the user.create hook provisions a workspace org + owner membership, and the
 * auth middleware resolves session -> orgId through org_members.
 *
 * Google sign-in activates when GOOGLE_CLIENT_ID/SECRET secrets exist —
 * flipping it on is a secret put, not a deploy (same pattern as the source
 * adapters).
 */
import { dash } from '@better-auth/infra';
import { betterAuth } from 'better-auth';
import { D1Dialect } from 'kysely-d1';
import { bootstrapOrgForUser } from '@mentions/core/ops/org-members';
import type { Env } from './types';

export type Auth = ReturnType<typeof buildAuth>;

function buildAuth(env: Env) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/v1/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: {
      dialect: new D1Dialect({ database: env.DB }),
      type: 'sqlite',
    },
    emailAndPassword: { enabled: true },
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {},
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await bootstrapOrgForUser({ db: env.DB, userId: user.id, email: user.email });
          },
        },
      },
    },
    trustedOrigins: env.TRUSTED_ORIGINS ? env.TRUSTED_ORIGINS.split(',') : [],
    advanced: { cookiePrefix: 'mentions' },
    // Hosted dashboard (dash.better-auth.com); process.env is not populated
    // on Workers, so the key must be passed from the binding explicitly.
    plugins: env.BETTER_AUTH_API_KEY ? [dash({ apiKey: env.BETTER_AUTH_API_KEY })] : [],
  });
}

let cached: { auth: Auth; env: Env } | null = null;

export function getAuth(env: Env): Auth {
  if (cached && cached.env === env) return cached.auth;
  const auth = buildAuth(env);
  cached = { auth, env };
  return auth;
}
