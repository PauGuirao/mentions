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

## Billing (Polar)

One bill, no add-ons: keywords are PRORATED PER DAY (EUR 5/30 per keyword-day,
so a full month = EUR 5) + EUR 5 per whole 1,000 relevant mentions past the
pooled allowance (500 x keyword max, pooled org-wide). Partial units are
forgiven. Pool growth applies PROSPECTIVELY: an already-billed unit stays
billed (standard quota semantics). Cycles are calendar-month UTC; the invoice
is Polar summing the period's events.

6. **D1 meters; Polar receives append-only daily facts.** `usage_cycles` +
   `billable_mentions` are the billing source of truth. A once-per-UTC-day
   scheduler tick (KV-gated; the mark is written only after success) emits:
   one `keyword_days` event per active org (that day's count — a missed day
   is an unbilled day, never a made-up one), mention units crossed since the
   last tick, and a closeout of prior unsettled cycles. Only events that can
   never become wrong later may be emitted — Polar meters cannot retract.
   Deterministic `external_id`s make every re-run free. Never call Polar from
   the request/pipeline hot path; only the scheduler and the API worker
   (checkout/portal/webhook) hold Polar credentials.
7. **Only relevant mentions are ever billable.** The billing record happens at
   the classifier's matched→classified transition (exactly-once via the state
   machine + `billable_mentions` PK; the repair path re-records idempotently).
   Filtered noise is free BY DESIGN — that is the positioning against
   competitors who count it.
8. **Billing errors favor the customer.** A crash window may under-count one
   mention; nothing may ever over-bill. Tick ordering: ingest events first,
   then advance `billed_units` (MAX-guarded, never backwards). The first-ever
   activation (`none`→`active` only — dunning recoveries and re-subscribes
   stay billable) baselines the current cycle BEFORE the status flip (so the
   daily tick can never see an active org with unforgiven free-period usage):
   keyword_max resets to the current count, free-period overage is forgiven
   with CEIL rounding. Webhooks guard against Polar's out-of-order retries:
   an old subscription's cancel never clobbers the active replacement, and a
   stale `active` never revives the same canceled subscription.
9. **Plan gating lives in core ops**, not routes, and the capacity check rides
   IN the write statement (`createKeyword`/unmute guard via `WHERE (SELECT
   COUNT...) < limit`) — a separate read-then-write races concurrent requests
   past the limit. Free = 2 keywords, active subscription = 100. Routes only
   translate `KeywordLimitError` → 402.

Polar setup (dashboard, once per env): one subscription product with two
metered prices — meter `keyword_days` (Sum over `count`, EUR 0.1667/unit =
EUR 5/30 per keyword-day) and meter `mention_units` (Count, EUR 5/unit).
Enable via secrets, no deploy:
`POLAR_ACCESS_TOKEN` + `POLAR_SERVER` (scheduler, api), `POLAR_WEBHOOK_SECRET`
+ `POLAR_PRODUCT_ID` (api). Webhook endpoint: `POST /v1/webhooks/polar`
(Standard Webhooks HMAC, raw-body verification — keep it out of body-parsing
middleware and the OpenAPI spec).

## Stack

- Workers + Queues + D1 + KV + R2 + Durable Objects (Bluesky firehose) + Cron.
- D1 through drizzle-orm: `packages/core/src/db/schema.ts` mirrors the SQL
  migrations, which stay hand-written and wrangler-applied (drizzle-kit only
  drafts new ones). Race-guarded writes (capacity gates, MAX-guards) stay raw
  sql`` — never rebuild them in the query builder. Drizzle wraps driver errors
  (DrizzleQueryError); constraint checks must walk err.cause.
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
