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
import { organization } from 'better-auth/plugins';
import { D1Dialect } from 'kysely-d1';
import { bootstrapOrgForUser } from '@mentions/core/ops/org-members';
import { buildAuthEmails } from './emails';
import type { Env } from './types';

export type Auth = ReturnType<typeof buildAuth>;

function buildAuth(env: Env) {
  const emails = buildAuthEmails(env);
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/v1/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: {
      dialect: new D1Dialect({ database: env.DB }),
      type: 'sqlite',
    },
    emailAndPassword: {
      enabled: true,
      ...(emails
        ? {
            sendResetPassword: async ({ user, url }) => {
              await emails.sendResetPassword({ user, url });
            },
          }
        : {}),
    },
    // Verification emails go out on signup once Resend is configured, but
    // requireEmailVerification stays OFF: flipping it on would lock out every
    // existing unverified account. Revisit once early users have verified.
    ...(emails
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({ user, url }) => {
              await emails.sendVerificationEmail({ user, url });
            },
          },
        }
      : {}),
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
            // Welcome email is best-effort: a Resend hiccup must never fail
            // the signup itself.
            if (emails) {
              try {
                await emails.sendWelcome({ user, appUrl: env.BETTER_AUTH_URL });
              } catch (err) {
                console.error(
                  '[auth] welcome email failed',
                  err instanceof Error ? err.message : err,
                );
              }
            }
          },
        },
      },
    },
    trustedOrigins: env.TRUSTED_ORIGINS ? env.TRUSTED_ORIGINS.split(',') : [],
    advanced: { cookiePrefix: 'mentions' },
    plugins: [
      // Membership lifecycle (invites, roles, active org) mapped onto the
      // CORE tenancy tables — orgs/org_members stay ours (see CLAUDE.md);
      // only `invitation` is plugin-owned. Org creation stays disabled:
      // workspaces come from the signup bootstrap, so plan gating has
      // exactly one org per paying identity.
      organization({
        schema: {
          organization: {
            modelName: 'orgs',
            fields: { createdAt: 'created_at', logo: 'logo_url' },
          },
          member: {
            modelName: 'org_members',
            fields: { organizationId: 'org_id', userId: 'user_id', createdAt: 'created_at' },
          },
        },
        allowUserToCreateOrganization: false,
        creatorRole: 'owner',
        ...(emails
          ? {
              sendInvitationEmail: async (data) => {
                await emails.sendInvitation({
                  email: data.email,
                  orgName: data.organization.name,
                  inviterEmail: data.inviter.user.email,
                  url: `${env.BETTER_AUTH_URL}/accept-invitation/${data.id}`,
                });
              },
            }
          : {}),
      }),
      // Hosted dashboard (dash.better-auth.com); process.env is not populated
      // on Workers, so the key must be passed from the binding explicitly.
      ...(env.BETTER_AUTH_API_KEY ? [dash({ apiKey: env.BETTER_AUTH_API_KEY })] : []),
    ],
  });
}

let cached: { auth: Auth; env: Env } | null = null;

export function getAuth(env: Env): Auth {
  if (cached && cached.env === env) return cached.auth;
  const auth = buildAuth(env);
  cached = { auth, env };
  return auth;
}
