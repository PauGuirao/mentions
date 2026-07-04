# workers/api (mentions-api)

REST API worker. Thin Hono + @hono/zod-openapi skin over the `@mentions/core`
ops layer; the OpenAPI spec is generated from the route definitions and served
at `/v1/openapi.json`.

- Auth: `Authorization: Bearer mk_live_...` (keys hashed SHA-256 in D1, verify
  result cached in KV for 300s). `/v1/health` and `/v1/openapi.json` are public.
- Errors: `{ "error": { "code", "message" } }` with stable codes
  (`unauthorized`, `not_found`, `validation_error`, `duplicate_keyword`,
  `invalid_cursor`, `internal_error`).

## Local setup

```sh
# 1. Install (repo root)
pnpm install

# 2. Apply the D1 schema (migrations live in packages/core/migrations)
cd workers/api
pnpm migrate:local        # = wrangler d1 migrations apply mentions --local

# 3. Seed a local org + API key (printed once)
pnpm seed

# 4. Run the worker
pnpm dev                  # http://localhost:8787
```

Export the seeded key for the examples below:

```sh
export MENTIONS_KEY=mk_live_...   # printed by pnpm seed
```

## Endpoints

### System (no auth)

```sh
curl http://localhost:8787/v1/health
curl http://localhost:8787/v1/openapi.json
```

### Keywords

```sh
# Create (kind: brand | competitor | topic, default brand)
curl -X POST http://localhost:8787/v1/keywords \
  -H "Authorization: Bearer $MENTIONS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"term": "Acme Corp", "kind": "brand"}'

# List
curl -H "Authorization: Bearer $MENTIONS_KEY" http://localhost:8787/v1/keywords

# Mute / unmute
curl -X PATCH http://localhost:8787/v1/keywords/kw_xxx \
  -H "Authorization: Bearer $MENTIONS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"muted": true}'

# Delete (also removes the keyword's mention matches)
curl -X DELETE -H "Authorization: Bearer $MENTIONS_KEY" http://localhost:8787/v1/keywords/kw_xxx
```

### Mentions

```sh
# Search (all filters optional; newest first; keyset pagination via nextCursor)
curl -H "Authorization: Bearer $MENTIONS_KEY" \
  "http://localhost:8787/v1/mentions?source=github&state=classified&minRelevance=70&q=pricing&limit=25"

# Next page
curl -H "Authorization: Bearer $MENTIONS_KEY" \
  "http://localhost:8787/v1/mentions?cursor=<nextCursor from previous response>"

# Get one (id = mention match id, mm_...)
curl -H "Authorization: Bearer $MENTIONS_KEY" http://localhost:8787/v1/mentions/mm_xxx

# Set state (users may only set ignored | done)
curl -X POST http://localhost:8787/v1/mentions/mm_xxx/state \
  -H "Authorization: Bearer $MENTIONS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state": "done"}'
```

### Company context

```sh
curl -H "Authorization: Bearer $MENTIONS_KEY" http://localhost:8787/v1/company

curl -X PUT http://localhost:8787/v1/company \
  -H "Authorization: Bearer $MENTIONS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"context": "We build a social media scheduling API for developers. Competitors: Buffer, Hootsuite."}'
```

### API keys

```sh
# Mint (key returned once; body may be {} for the default name)
curl -X POST http://localhost:8787/v1/api-keys \
  -H "Authorization: Bearer $MENTIONS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "ci"}'

# List (prefixes only)
curl -H "Authorization: Bearer $MENTIONS_KEY" http://localhost:8787/v1/api-keys

# Revoke
curl -X DELETE -H "Authorization: Bearer $MENTIONS_KEY" http://localhost:8787/v1/api-keys/key_xxx
```

## Checks

```sh
pnpm typecheck        # workers/api
pnpm --filter @mentions/core test   # ops unit tests (repo root)
```

## Deploy notes

`wrangler.jsonc` ships with `database_id`/KV `id` set to `TBD-LOCAL`; local
dev ignores them. Replace both with real resource ids before any deploy.
