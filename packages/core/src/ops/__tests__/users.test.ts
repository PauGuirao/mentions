import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../api-keys';
import { hashPassword, verifyPassword } from '../passwords';
import { createSession, generateSessionToken, revokeSession, verifySession } from '../sessions';
import { DuplicateUserError, InvalidCredentialsError, login, normalizeEmail, signup } from '../users';
import { createDbStub, createKvStub } from './stubs';

describe('passwords', () => {
  it('round-trips: verifies the password it hashed', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('right');
    await expect(verifyPassword('wrong', stored)).resolves.toBe(false);
  });

  it('salts: same password hashes differently each time', async () => {
    expect(await hashPassword('pw123456')).not.toBe(await hashPassword('pw123456'));
  });

  it('rejects malformed stored values without throwing', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', 'pbkdf2$abc$00$00')).resolves.toBe(false);
    await expect(verifyPassword('x', '')).resolves.toBe(false);
  });
});

describe('sessions', () => {
  it('generates sess_ + 32 hex tokens', () => {
    expect(generateSessionToken()).toMatch(/^sess_[0-9a-f]{32}$/);
  });

  it('createSession stores the hash, never the token', async () => {
    const { db, queries } = createDbStub();
    const { token, expiresAt } = await createSession({ db, userId: 'usr_1' });

    expect(token).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(queries).toHaveLength(1);
    const insert = queries[0]!;
    expect(insert.sql).toContain('INSERT INTO sessions');
    expect(insert.params).toContain(await sha256Hex(token));
    expect(insert.params).not.toContain(token);
  });

  it('verifySession rejects non-sess_ tokens without touching storage', async () => {
    const { db, queries } = createDbStub();
    await expect(verifySession({ db, token: 'mk_live_00ff' })).resolves.toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('verifySession resolves user + org from D1 and caches in KV', async () => {
    const token = generateSessionToken();
    const { db, queries } = createDbStub((query) =>
      query.sql.includes('SELECT')
        ? { first: { session_id: 'sess_row', user_id: 'usr_1', org_id: 'org_1' } }
        : {},
    );
    const { kv, puts } = createKvStub();

    await expect(verifySession({ db, kv, token })).resolves.toEqual({ userId: 'usr_1', orgId: 'org_1' });
    expect(queries.some((q) => q.sql.includes('UPDATE sessions SET last_used_at'))).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(`sess:${await sha256Hex(token)}`);

    // Second verify hits the cache: no further SELECT.
    const before = queries.length;
    await expect(verifySession({ db, kv, token })).resolves.toEqual({ userId: 'usr_1', orgId: 'org_1' });
    expect(queries.length).toBe(before);
  });

  it('verifySession returns null for unknown or expired tokens', async () => {
    const { db } = createDbStub(() => ({ first: null }));
    await expect(verifySession({ db, token: generateSessionToken() })).resolves.toBeNull();
  });

  it('revokeSession deletes the row and evicts the cache', async () => {
    const token = generateSessionToken();
    const { db, queries } = createDbStub();
    const { kv, deletes } = createKvStub();

    await expect(revokeSession({ db, kv, token })).resolves.toBe(true);
    expect(queries[0]!.sql).toContain('DELETE FROM sessions');
    expect(deletes).toEqual([`sess:${await sha256Hex(token)}`]);
  });
});

describe('signup', () => {
  it('creates user, org, and owner membership in one batch; never stores the password', async () => {
    const { db, queries } = createDbStub();
    const result = await signup({ db, email: '  Pau@Zernio.com ', password: 'pw123456' });

    expect(result.user.email).toBe('pau@zernio.com');
    expect(result.user.id).toMatch(/^usr_/);
    expect(result.orgId).toMatch(/^org_/);
    expect(result.session.token).toMatch(/^sess_/);

    const sqls = queries.map((q) => q.sql);
    expect(sqls.filter((s) => s.includes('INSERT INTO users'))).toHaveLength(1);
    expect(sqls.filter((s) => s.includes('INSERT INTO orgs'))).toHaveLength(1);
    expect(sqls.filter((s) => s.includes('INSERT INTO org_members'))).toHaveLength(1);
    for (const query of queries) {
      expect(query.params).not.toContain('pw123456');
    }
    const orgInsert = queries.find((q) => q.sql.includes('INSERT INTO orgs'))!;
    expect(orgInsert.params).toContain("pau's workspace");
  });

  it('maps the UNIQUE email violation to DuplicateUserError', async () => {
    const { db } = createDbStub((query) =>
      query.sql.includes('INSERT INTO users')
        ? { error: new Error('D1_ERROR: UNIQUE constraint failed: users.email') }
        : {},
    );
    await expect(signup({ db, email: 'a@b.co', password: 'pw123456' })).rejects.toBeInstanceOf(
      DuplicateUserError,
    );
  });
});

describe('login', () => {
  it('verifies the password and mints a session', async () => {
    const passwordHash = await hashPassword('pw123456');
    const { db } = createDbStub((query) =>
      query.sql.includes('FROM users')
        ? {
            first: {
              id: 'usr_1',
              email: 'a@b.co',
              name: '',
              password_hash: passwordHash,
              created_at: 1,
            },
          }
        : {},
    );
    const result = await login({ db, email: 'A@B.co', password: 'pw123456' });
    expect(result.user.id).toBe('usr_1');
    expect(result.session.token).toMatch(/^sess_/);
  });

  it('throws InvalidCredentialsError for unknown email and for wrong password alike', async () => {
    const { db: emptyDb } = createDbStub(() => ({ first: null }));
    await expect(login({ db: emptyDb, email: 'no@one.co', password: 'x' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    const passwordHash = await hashPassword('right-pw');
    const { db } = createDbStub((query) =>
      query.sql.includes('FROM users')
        ? { first: { id: 'usr_1', email: 'a@b.co', name: '', password_hash: passwordHash, created_at: 1 } }
        : {},
    );
    await expect(login({ db, email: 'a@b.co', password: 'wrong-pw' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Pau@Zernio.COM ')).toBe('pau@zernio.com');
  });
});
