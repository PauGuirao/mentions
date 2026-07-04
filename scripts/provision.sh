#!/usr/bin/env bash
# One-time Cloudflare resource provisioning. Requires: wrangler login done.
# Prints the ids to paste over TBD-LOCAL in workers/*/wrangler.jsonc.
set -euo pipefail

echo "== D1 =="
npx wrangler d1 create mentions || true
echo "== KV =="
npx wrangler kv namespace create KV || true
echo "== Queues =="
for q in mentions-fetch-jobs mentions-raw-items mentions-classify mentions-deliver; do
  npx wrangler queues create "$q" || true
done
echo
echo "Paste the printed database_id / kv id into every workers/*/wrangler.jsonc (TBD-LOCAL),"
echo "then: wrangler d1 migrations apply mentions --remote -c workers/api/wrangler.jsonc"
echo "then deploy each worker: (cd workers/<name> && npx wrangler deploy)"
