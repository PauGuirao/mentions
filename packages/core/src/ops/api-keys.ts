/**
 * API key mint/verify/list/revoke. Keys are shown once at mint; only the
 * SHA-256 hex of the full key is stored. Verification is KV-cached (TTL 300s)
 * with D1 as the source of truth.
 */
import { newId } from '../ids';

const API_KEY_PREFIX = 'mk_live_';
/** "mk_live_" + first 4 hex chars, e.g. "mk_live_ab12" - enough to recognize
 *  a key in a list without being useful to an attacker. */
const PREFIX_DISPLAY_LENGTH = 12;
const KV_CACHE_TTL_SECONDS = 300;

const kvCacheKey = (hash: string): string => `ak:${hash}`;

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

/** Key material only (no storage) - shared by mintApiKey and the local seed script. */
export function generateApiKey(): { key: string; prefix: string } {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const key = `${API_KEY_PREFIX}${toHex(bytes)}`;
  return { key, prefix: key.slice(0, PREFIX_DISPLAY_LENGTH) };
}

export async function mintApiKey(args: {
  db: D1Database;
  orgId: string;
  name?: string;
}): Promise<{ key: string; id: string; prefix: string }> {
  const { db, orgId, name } = args;
  const { key, prefix } = generateApiKey();
  const id = newId('key');
  await db
    .prepare('INSERT INTO api_keys (id, org_id, key_hash, prefix, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, orgId, await sha256Hex(key), prefix, name ?? 'default', Date.now())
    .run();
  return { key, id, prefix };
}

export async function verifyApiKey(args: {
  db: D1Database;
  kv?: KVNamespace;
  token: string;
}): Promise<{ orgId: string } | null> {
  const { db, kv, token } = args;
  if (!token.startsWith(API_KEY_PREFIX)) return null;

  const hash = await sha256Hex(token);

  if (kv) {
    try {
      const cached = await kv.get(kvCacheKey(hash));
      if (cached) return { orgId: cached };
    } catch {
      // Cache is best-effort; fall through to D1.
    }
  }

  const row = await db
    .prepare('SELECT id, org_id FROM api_keys WHERE key_hash = ?')
    .bind(hash)
    .first<{ id: string; org_id: string }>();
  if (!row) return null;

  // Bookkeeping must never fail an otherwise valid auth.
  if (kv) {
    try {
      await kv.put(kvCacheKey(hash), row.org_id, { expirationTtl: KV_CACHE_TTL_SECONDS });
    } catch {
      // best-effort
    }
  }
  try {
    await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  } catch {
    // best-effort
  }

  return { orgId: row.org_id };
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export async function listApiKeys(args: { db: D1Database; orgId: string }): Promise<ApiKeySummary[]> {
  const { results } = await args.db
    .prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE org_id = ? ORDER BY created_at DESC')
    .bind(args.orgId)
    .all<{ id: string; name: string; prefix: string; created_at: number; last_used_at: number | null }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function revokeApiKey(args: {
  db: D1Database;
  kv?: KVNamespace;
  orgId: string;
  apiKeyId: string;
}): Promise<boolean> {
  const { db, kv, orgId, apiKeyId } = args;
  const row = await db
    .prepare('DELETE FROM api_keys WHERE id = ? AND org_id = ? RETURNING key_hash')
    .bind(apiKeyId, orgId)
    .first<{ key_hash: string }>();
  if (!row) return false;

  // Evict the verify cache so a revoked key stops working within one request,
  // not after the 300s TTL.
  if (kv) {
    try {
      await kv.delete(kvCacheKey(row.key_hash));
    } catch {
      // best-effort
    }
  }
  return true;
}
