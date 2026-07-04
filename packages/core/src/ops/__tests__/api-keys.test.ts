import { describe, expect, it } from 'vitest';
import { generateApiKey, listApiKeys, mintApiKey, revokeApiKey, sha256Hex, verifyApiKey } from '../api-keys';
import { createDbStub, createKvStub } from './stubs';

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
    const { db, queries } = createDbStub();
    const minted = await mintApiKey({ db, orgId: 'org_1', name: 'ci' });

    expect(minted.key).toMatch(/^mk_live_[0-9a-f]{32}$/);
    expect(minted.id).toMatch(/^key_/);
    expect(minted.prefix).toBe(minted.key.slice(0, 12));

    expect(queries).toHaveLength(1);
    const insert = queries[0]!;
    expect(insert.sql).toContain('INSERT INTO api_keys');
    const [id, orgId, keyHash, prefix, name] = insert.params;
    expect(id).toBe(minted.id);
    expect(orgId).toBe('org_1');
    expect(keyHash).toBe(await sha256Hex(minted.key));
    expect(prefix).toBe(minted.prefix);
    expect(name).toBe('ci');
    expect(insert.params).not.toContain(minted.key);
  });

  it('defaults the name to "default"', async () => {
    const { db, queries } = createDbStub();
    await mintApiKey({ db, orgId: 'org_1' });
    expect(queries[0]!.params[4]).toBe('default');
  });
});

describe('verifyApiKey', () => {
  const token = 'mk_live_00112233445566778899aabbccddeeff';

  it('rejects tokens without the mk_live_ prefix without touching storage', async () => {
    const { db, queries } = createDbStub();
    const result = await verifyApiKey({ db, token: 'sk_other_abc' });
    expect(result).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('returns the org from KV cache without querying D1', async () => {
    const hash = await sha256Hex(token);
    const { kv } = createKvStub({ [`ak:${hash}`]: 'org_cached' });
    const { db, queries } = createDbStub();

    const result = await verifyApiKey({ db, kv, token });
    expect(result).toEqual({ orgId: 'org_cached' });
    expect(queries).toHaveLength(0);
  });

  it('falls back to D1 on cache miss, caches with TTL 300 and touches last_used_at', async () => {
    const { kv, puts } = createKvStub();
    const { db, queries } = createDbStub((query) =>
      query.sql.startsWith('SELECT') ? { first: { id: 'key_1', org_id: 'org_db' } } : {},
    );

    const result = await verifyApiKey({ db, kv, token });
    expect(result).toEqual({ orgId: 'org_db' });

    const hash = await sha256Hex(token);
    expect(puts).toEqual([{ key: `ak:${hash}`, value: 'org_db', options: { expirationTtl: 300 } }]);

    const update = queries.find((q) => q.sql.includes('last_used_at'));
    expect(update).toBeDefined();
    expect(update!.params[1]).toBe('key_1');
  });

  it('returns null for an unknown key', async () => {
    const { db } = createDbStub(() => ({ first: null }));
    const result = await verifyApiKey({ db, token });
    expect(result).toBeNull();
  });

  it('still verifies when the KV cache write fails', async () => {
    const failingKv = {
      get: async () => null,
      put: async () => {
        throw new Error('kv down');
      },
      delete: async () => {},
    } as unknown as KVNamespace;
    const { db } = createDbStub((query) =>
      query.sql.startsWith('SELECT') ? { first: { id: 'key_1', org_id: 'org_db' } } : {},
    );

    const result = await verifyApiKey({ db, kv: failingKv, token });
    expect(result).toEqual({ orgId: 'org_db' });
  });
});

describe('listApiKeys', () => {
  it('maps rows to camelCase summaries', async () => {
    const { db } = createDbStub(() => ({
      results: [
        { id: 'key_1', name: 'default', prefix: 'mk_live_ab12', created_at: 100, last_used_at: null },
      ],
    }));
    const keys = await listApiKeys({ db, orgId: 'org_1' });
    expect(keys).toEqual([
      { id: 'key_1', name: 'default', prefix: 'mk_live_ab12', createdAt: 100, lastUsedAt: null },
    ]);
  });
});

describe('revokeApiKey', () => {
  it('deletes the row and evicts the KV cache entry', async () => {
    const { kv, deletes } = createKvStub({ 'ak:somehash': 'org_1' });
    const { db, queries } = createDbStub((query) =>
      query.sql.startsWith('DELETE') ? { first: { key_hash: 'somehash' } } : {},
    );

    const revoked = await revokeApiKey({ db, kv, orgId: 'org_1', apiKeyId: 'key_1' });
    expect(revoked).toBe(true);
    expect(deletes).toEqual(['ak:somehash']);
    expect(queries[0]!.sql).toContain('RETURNING key_hash');
    expect(queries[0]!.params).toEqual(['key_1', 'org_1']);
  });

  it('returns false when the key does not belong to the org', async () => {
    const { db } = createDbStub(() => ({ first: null }));
    const revoked = await revokeApiKey({ db, orgId: 'org_other', apiKeyId: 'key_1' });
    expect(revoked).toBe(false);
  });
});
