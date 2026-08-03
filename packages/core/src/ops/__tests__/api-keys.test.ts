import { describe, expect, it } from 'vitest';
import { generateApiKey, listApiKeys, mintApiKey, revokeApiKey, sha256Hex, verifyApiKey } from '../api-keys';
import { createTestD1, seedOrg } from './d1-sqlite';
import { createKvStub } from './stubs';

async function setup(): Promise<D1Database> {
  const db = createTestD1();
  await seedOrg(db, 'org_1');
  return db;
}

describe('generateApiKey', () => {
  it('produces mk_live_ + 32 hex chars with a 12-char display prefix', () => {
    const { key, prefix } = generateApiKey();
    expect(key).toMatch(/^mk_live_[0-9a-f]{32}$/);
    expect(prefix).toBe(key.slice(0, 12));
  });

  it('produces unique keys', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key));
    expect(keys.size).toBe(50);
  });
});

describe('mintApiKey', () => {
  it('stores the SHA-256 hex of the key, never the key itself', async () => {
    const db = await setup();
    const minted = await mintApiKey({ db, orgId: 'org_1', name: 'ci' });

    expect(minted.key).toMatch(/^mk_live_[0-9a-f]{32}$/);
    expect(minted.id).toMatch(/^key_/);
    const row = await db
      .prepare('SELECT key_hash, prefix, name FROM api_keys WHERE id = ?1')
      .bind(minted.id)
      .first<{ key_hash: string; prefix: string; name: string }>();
    expect(row?.key_hash).toBe(await sha256Hex(minted.key));
    expect(row?.key_hash).not.toBe(minted.key);
    expect(row?.prefix).toBe(minted.key.slice(0, 12));
    expect(row?.name).toBe('ci');
  });

  it('defaults the name to "default"', async () => {
    const db = await setup();
    const minted = await mintApiKey({ db, orgId: 'org_1' });
    const keys = await listApiKeys({ db, orgId: 'org_1' });
    expect(keys[0]).toMatchObject({ id: minted.id, name: 'default' });
  });
});

describe('verifyApiKey', () => {
  it('rejects tokens without the mk_live_ prefix', async () => {
    const db = await setup();
    await expect(verifyApiKey({ db, token: 'sk_other_abc' })).resolves.toBeNull();
  });

  it('verifies a minted key against D1 and touches last_used_at', async () => {
    const db = await setup();
    const minted = await mintApiKey({ db, orgId: 'org_1' });
    await expect(verifyApiKey({ db, token: minted.key })).resolves.toEqual({ orgId: 'org_1' });
    const row = await db
      .prepare('SELECT last_used_at FROM api_keys WHERE id = ?1')
      .bind(minted.id)
      .first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).not.toBeNull();
  });

  it('caches the verdict in KV with TTL 300 and serves from cache afterwards', async () => {
    const db = await setup();
    const { kv, puts } = createKvStub();
    const minted = await mintApiKey({ db, orgId: 'org_1' });

    await expect(verifyApiKey({ db, kv, token: minted.key })).resolves.toEqual({ orgId: 'org_1' });
    const hash = await sha256Hex(minted.key);
    expect(puts).toEqual([{ key: `ak:${hash}`, value: 'org_1', options: { expirationTtl: 300 } }]);

    // Prove the second verify is a cache hit: the D1 row is gone, yet the
    // cached org still answers.
    await db.prepare('DELETE FROM api_keys WHERE id = ?1').bind(minted.id).run();
    await expect(verifyApiKey({ db, kv, token: minted.key })).resolves.toEqual({ orgId: 'org_1' });
  });

  it('returns null for an unknown key', async () => {
    const db = await setup();
    await expect(
      verifyApiKey({ db, token: 'mk_live_00112233445566778899aabbccddeeff' }),
    ).resolves.toBeNull();
  });

  it('still verifies when the KV cache write fails', async () => {
    const db = await setup();
    const minted = await mintApiKey({ db, orgId: 'org_1' });
    const failingKv = {
      get: async () => null,
      put: async () => {
        throw new Error('kv down');
      },
      delete: async () => {},
    } as unknown as KVNamespace;
    await expect(verifyApiKey({ db, kv: failingKv, token: minted.key })).resolves.toEqual({
      orgId: 'org_1',
    });
  });
});

describe('listApiKeys', () => {
  it('maps rows to camelCase summaries, newest first', async () => {
    const db = await setup();
    await db
      .prepare(
        `INSERT INTO api_keys (id, org_id, key_hash, prefix, name, created_at, last_used_at) VALUES
         ('key_old', 'org_1', 'h1', 'mk_live_aaaa', 'old', 100, NULL),
         ('key_new', 'org_1', 'h2', 'mk_live_bbbb', 'new', 200, 300)`,
      )
      .run();
    await expect(listApiKeys({ db, orgId: 'org_1' })).resolves.toEqual([
      { id: 'key_new', name: 'new', prefix: 'mk_live_bbbb', createdAt: 200, lastUsedAt: 300 },
      { id: 'key_old', name: 'old', prefix: 'mk_live_aaaa', createdAt: 100, lastUsedAt: null },
    ]);
  });
});

describe('revokeApiKey', () => {
  it('deletes the row and evicts the KV cache entry', async () => {
    const db = await setup();
    const { kv, deletes } = createKvStub();
    const minted = await mintApiKey({ db, orgId: 'org_1' });
    await verifyApiKey({ db, kv, token: minted.key });

    const revoked = await revokeApiKey({ db, kv, orgId: 'org_1', apiKeyId: minted.id });
    expect(revoked).toBe(true);
    expect(deletes).toEqual([`ak:${await sha256Hex(minted.key)}`]);
    // Cache evicted + row gone: the key is dead immediately.
    await expect(verifyApiKey({ db, kv, token: minted.key })).resolves.toBeNull();
  });

  it('returns false when the key does not belong to the org', async () => {
    const db = await setup();
    await seedOrg(db, 'org_other');
    const minted = await mintApiKey({ db, orgId: 'org_1' });
    await expect(
      revokeApiKey({ db, orgId: 'org_other', apiKeyId: minted.id }),
    ).resolves.toBe(false);
  });
});
