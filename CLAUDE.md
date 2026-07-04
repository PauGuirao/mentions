# Mentions — social listening, API/MCP-first

**What**: keyword/brand mention tracking across dev platforms (Bluesky, HN, GitHub,
Stack Overflow, DEV in MVP). Octolens-class product. Everything runs on Cloudflare.

## Architecture invariants

1. **One operations layer.** `packages/core` owns zod schemas, D1 access, and
   operation functions (`createKeyword`, `searchMentions`, ...). The REST API,
   the MCP server, and any cron are thin skins over it. Never put product logic
   in a worker's handler.
2. **Ingest once, match all tenants.** `mentions` rows are global (deduped on
   source+external_id); `mention_matches` is the tenant-scoped row. Search-API
   sources are polled per unique normalized term, never per org.
3. **Pipeline stages are queues**: fetch-<source> → raw-items → classify →
   deliver. A stage only reads its input queue and writes its output queue.
4. **Fail toward re-processing, never loss**: consumers must be idempotent
   (dedupe on insert; delivery dedupe on delivery id).
5. **Sources are adapters** (`packages/core/src/sources/`): `fetchSince(cursor)`
   → `RawItem[]`. Transport is either `direct` (official API) or `provider`
   (scrape vendor) — nothing outside the adapter may know which.

## Stack

- Workers + Queues + D1 + KV + R2 + Durable Objects (Bluesky firehose) + Cron.
- API worker: Hono + @hono/zod-openapi; spec generated from code, served at
  /v1/openapi.json. Auth: Bearer API keys, hashed (SHA-256) in D1, KV-cached.
- Classifier: Workers AI through AI Gateway. Model choice is config, not code.
- TypeScript strict everywhere; no `as any` (narrowest cast or a real interface).
- pnpm workspaces. Each worker has its own wrangler.jsonc + `typecheck` script.

## Conventions

- Zod schemas live in core and are the single source of truth for API request/
  response types, queue message shapes, and MCP tool inputs. Infer, don't re-declare.
- Queue names + message schemas: `packages/core/src/pipeline.ts`. Never inline one.
- Cursor bookkeeping per (source, term?) in the `cursors` table.
- Money/API-budget guards live next to the adapter that spends them.
- No em dashes in user-facing copy.
