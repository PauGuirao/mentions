import { defineConfig } from 'drizzle-kit';

/**
 * Migrations remain hand-written SQL in ./migrations, applied with
 * `wrangler d1 migrations apply` — drizzle-kit is used to DRAFT new ones
 * (`pnpm exec drizzle-kit generate`) after editing src/db/schema.ts; review
 * and rename the output before committing. Never point drizzle-kit at a
 * database directly.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
});
