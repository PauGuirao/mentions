/**
 * Seeds the LOCAL D1 database (wrangler dev state) with one org and prints a
 * usable API key. Run from workers/api via `pnpm seed` (after migrations).
 * Reuses the exact key-material helpers the API itself uses, so the printed
 * key verifies against the stored hash.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateApiKey, sha256Hex } from '@mentions/core/ops/api-keys';
import { newId } from '@mentions/core/ids';

const orgId = newId('org');
const keyId = newId('key');
const { key, prefix } = generateApiKey();
const keyHash = await sha256Hex(key);
const now = Date.now();

// All values are generated ids/hex, safe to inline.
const sql = [
  `INSERT INTO orgs (id, name, created_at) VALUES ('${orgId}', 'Local Dev Org', ${now});`,
  `INSERT INTO api_keys (id, org_id, key_hash, prefix, name, created_at) VALUES ('${keyId}', '${orgId}', '${keyHash}', '${prefix}', 'local-dev', ${now});`,
].join(' ');

const workerDir = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync('wrangler', ['d1', 'execute', 'mentions', '--local', '--command', sql], {
  cwd: workerDir,
  stdio: 'inherit',
});

if (result.error) {
  console.error('Failed to run wrangler (run this script via `pnpm seed` so wrangler is on PATH):', result.error);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('');
console.log(`Seeded local org: ${orgId}`);
console.log(`API key (shown once, store it now): ${key}`);
console.log('');
console.log('Try it against `pnpm dev`:');
console.log(`  curl -H "Authorization: Bearer ${key}" http://localhost:8787/v1/keywords`);
