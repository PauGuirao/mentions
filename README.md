# Mentions

API/MCP-first social listening for dev platforms. Everything runs on Cloudflare
(Workers, Queues, D1, KV, Durable Objects, Workers AI). See CLAUDE.md for the
architecture invariants; each worker's wrangler.jsonc documents its bindings.

## Pipeline

scheduler (cron) -> q:fetch-jobs -> ingest (HN/GitHub/SO/DEV/Reddit/X/YouTube adapters)
firehose-bluesky (DO + Jetstream websocket) ────────┐
ingest ─────────────────────────────────────────────┴-> q:raw-items
  -> matcher (dedupe + multi-tenant keyword match) -> q:classify
  -> classifier (Workers AI relevance/sentiment)   -> q:deliver
  -> deliverer (feeds -> webhook/slack)

Surfaces: workers/api (REST, OpenAPI generated from code) + workers/mcp.

## Local dev

```sh
pnpm install
pnpm migrate:local          # apply D1 schema (local sqlite)
pnpm seed                   # org + api key (printed once)
pnpm dev                    # all workers in one wrangler session, shared local queues/D1
```

- API at the printed localhost port: `curl -H "Authorization: Bearer mk_live_..." localhost:8787/v1/keywords`
- Cron doesn't tick automatically in dev: `curl "localhost:8787/__scheduled?cron=*+*+*+*+*"` against the scheduler, or just wait for the Bluesky firehose (start it: `POST /start` on the firehose worker with ADMIN_SECRET) — it streams real Jetstream posts into the pipeline.
- Classifier uses the Workers AI binding, which runs REMOTELY even in dev (needs a logged-in wrangler + billed CF account). Without it, matches stay in state 'matched'.

## Provisioning (real Cloudflare account)

`bash scripts/provision.sh` — creates the D1 database, KV namespace, and the
four queues, then prints the ids to paste over the TBD-LOCAL placeholders in
each workers/*/wrangler.jsonc. Then per worker: `wrangler deploy`. Apply
migrations remotely with `wrangler d1 migrations apply mentions --remote`.
