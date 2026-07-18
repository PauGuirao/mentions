/** Codegen-only Better Auth config + schema SQL printer. The stub D1 answers
 *  every query with zero rows so kysely introspection sees an empty database
 *  and getMigrations emits the full schema. Run:
 *    npx tsx scripts/ba-codegen.ts
 */
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { D1Dialect } from 'kysely-d1';

interface StubStatement {
  bind(...args: unknown[]): StubStatement;
  all(): Promise<{ results: unknown[]; success: true; meta: Record<string, never> }>;
  raw(): Promise<unknown[]>;
  first(): Promise<null>;
  run(): Promise<{ success: true; meta: Record<string, never> }>;
}

const stubStatement: StubStatement = {
  bind: () => stubStatement,
  all: async () => ({ results: [], success: true, meta: {} }),
  raw: async () => [],
  first: async () => null,
  run: async () => ({ success: true, meta: {} }),
};

const stubD1 = {
  prepare: () => stubStatement,
  batch: async () => [],
  exec: async () => ({ count: 0, duration: 0 }),
} as unknown as D1Database;

const auth = betterAuth({
  baseURL: 'http://localhost:8787',
  basePath: '/v1/auth',
  secret: 'codegen-only-not-a-secret',
  database: { dialect: new D1Dialect({ database: stubD1 }), type: 'sqlite' },
  emailAndPassword: { enabled: true },
  socialProviders: { google: { clientId: 'x', clientSecret: 'x' } },
});

const { compileMigrations } = await getMigrations(auth.options);
console.log(await compileMigrations());
