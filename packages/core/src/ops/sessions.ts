/**
 * Bearer session tokens for human users, mirroring the api-keys pattern:
 * "sess_" + 32 hex chars, only the SHA-256 hex stored, verification KV-cached
 * (TTL 300s) with D1 as the source of truth. A session resolves to BOTH a
 * user and that user's org so org-scoped handlers work unchanged.
 */
import { newId } from '../ids';
import { sha256Hex } from './api-keys';

const SESSION_PREFIX = 'sess_';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KV_CACHE_TTL_SECONDS = 300;

const kvCacheKey = (hash: string): string => `sess:${hash}`;

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function generateSessionToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${SESSION_PREFIX}${toHex(bytes)}`;
}

export interface SessionAuth {
  userId: string;
  orgId: string;
}

export async function createSession(args: {
  db: D1Database;
  userId: string;
}): Promise<{ token: string; expiresAt: number }> {
  const { db, userId } = args;
  const token = generateSessionToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db
    .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newId('sess'), userId, await sha256Hex(token), expiresAt, Date.now())
    .run();
  return { token, expiresAt };
}

export async function verifySession(args: {
  db: D1Database;
  kv?: KVNamespace;
  token: string;
}): Promise<SessionAuth | null> {
  const { db, kv, token } = args;
  if (!token.startsWith(SESSION_PREFIX)) return null;

  const hash = await sha256Hex(token);

  if (kv) {
    try {
      const cached = await kv.get(kvCacheKey(hash));
      if (cached) return JSON.parse(cached) as SessionAuth;
    } catch {
      // Cache is best-effort; fall through to D1.
    }
  }

  // A user's org is their oldest membership (MVP: one org per user; the
  // membership row is the future hook for org switching).
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, om.org_id FROM sessions s
       JOIN org_members om ON om.user_id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?
       ORDER BY om.created_at ASC LIMIT 1`,
    )
    .bind(hash, Date.now())
    .first<{ session_id: string; user_id: string; org_id: string }>();
  if (!row) return null;

  const auth: SessionAuth = { userId: row.user_id, orgId: row.org_id };

  // Bookkeeping must never fail an otherwise valid auth.
  if (kv) {
    try {
      await kv.put(kvCacheKey(hash), JSON.stringify(auth), { expirationTtl: KV_CACHE_TTL_SECONDS });
    } catch {
      // best-effort
    }
  }
  try {
    await db
      .prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?')
      .bind(Date.now(), row.session_id)
      .run();
  } catch {
    // best-effort
  }

  return auth;
}

export async function revokeSession(args: {
  db: D1Database;
  kv?: KVNamespace;
  token: string;
}): Promise<boolean> {
  const { db, kv, token } = args;
  if (!token.startsWith(SESSION_PREFIX)) return false;
  const hash = await sha256Hex(token);

  const result = await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();

  // Evict the verify cache so logout takes effect within one request, not
  // after the 300s TTL.
  if (kv) {
    try {
      await kv.delete(kvCacheKey(hash));
    } catch {
      // best-effort
    }
  }
  return (result.meta.changes ?? 0) > 0;
}
