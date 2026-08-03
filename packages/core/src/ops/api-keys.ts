/**
 * API key mint/verify/list/revoke. Keys are shown once at mint; only the
 * SHA-256 hex of the full key is stored. Verification is KV-cached (TTL 300s)
 * with D1 as the source of truth.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { apiKeys } from '../db/schema';
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
  await getDb(db).insert(apiKeys).values({
    id,
    orgId,
    keyHash: await sha256Hex(key),
    prefix,
    name: name ?? 'default',
    createdAt: Date.now(),
  });
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

  const orm = getDb(db);
  const row = await orm
    .select({ id: apiKeys.id, orgId: apiKeys.orgId })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .get();
  if (!row) return null;

  // Bookkeeping must never fail an otherwise valid auth.
  if (kv) {
    try {
      await kv.put(kvCacheKey(hash), row.orgId, { expirationTtl: KV_CACHE_TTL_SECONDS });
    } catch {
      // best-effort
    }
  }
  try {
    await orm.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id));
  } catch {
    // best-effort
  }

  return { orgId: row.orgId };
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export async function listApiKeys(args: { db: D1Database; orgId: string }): Promise<ApiKeySummary[]> {
  return getDb(args.db)
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.orgId, args.orgId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(args: {
  db: D1Database;
  kv?: KVNamespace;
  orgId: string;
  apiKeyId: string;
}): Promise<boolean> {
  const { db, kv, orgId, apiKeyId } = args;
  const deleted = await getDb(db)
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.orgId, orgId)))
    .returning({ keyHash: apiKeys.keyHash });
  const row = deleted[0];
  if (!row) return false;

  // Evict the verify cache so a revoked key stops working within one request,
  // not after the 300s TTL.
  if (kv) {
    try {
      await kv.delete(kvCacheKey(row.keyHash));
    } catch {
      // best-effort
    }
  }
  return true;
}
