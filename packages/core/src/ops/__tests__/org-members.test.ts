import { describe, expect, it } from 'vitest';
import { bootstrapOrgForUser, getOrgForUser, getUserWithOrgs } from '../org-members';
import { createDbStub } from './stubs';

describe('bootstrapOrgForUser', () => {
  it('creates an org and owner membership for a fresh user', async () => {
    const { db, queries } = createDbStub(() => ({ first: null }));
    const result = await bootstrapOrgForUser({ db, userId: 'u1', email: 'pau@zernio.com' });

    expect(result.created).toBe(true);
    expect(result.orgId).toMatch(/^org_/);
    const sqls = queries.map((q) => q.sql);
    expect(sqls.filter((s) => s.includes('INSERT INTO orgs'))).toHaveLength(1);
    expect(sqls.filter((s) => s.includes('INSERT INTO org_members'))).toHaveLength(1);
    const orgInsert = queries.find((q) => q.sql.includes('INSERT INTO orgs'))!;
    expect(orgInsert.params).toContain("pau's workspace");
  });

  it('is idempotent: bails when a membership already exists', async () => {
    const { db, queries } = createDbStub((query) =>
      query.sql.includes('SELECT org_id') ? { first: { org_id: 'org_existing' } } : {},
    );
    const result = await bootstrapOrgForUser({ db, userId: 'u1', email: 'a@b.co' });
    expect(result).toEqual({ orgId: 'org_existing', created: false });
    expect(queries.some((q) => q.sql.includes('INSERT'))).toBe(false);
  });
});

describe('getOrgForUser', () => {
  it('returns the oldest membership org, or null', async () => {
    const { db } = createDbStub(() => ({ first: { org_id: 'org_1' } }));
    await expect(getOrgForUser({ db, userId: 'u1' })).resolves.toBe('org_1');

    const { db: empty } = createDbStub(() => ({ first: null }));
    await expect(getOrgForUser({ db: empty, userId: 'u1' })).resolves.toBeNull();
  });
});

describe('getUserWithOrgs', () => {
  it('normalizes ISO-string createdAt from the Better Auth table to epoch ms', async () => {
    const { db } = createDbStub((query) => {
      if (query.sql.includes('FROM "user"')) {
        return {
          first: { id: 'u1', email: 'a@b.co', name: 'A', createdAt: '2026-07-18T10:00:00.000Z' },
        };
      }
      return { results: [{ id: 'org_1', name: 'Zernio', role: 'owner' }] };
    });
    const me = await getUserWithOrgs({ db, userId: 'u1' });
    expect(me?.user.createdAt).toBe(Date.parse('2026-07-18T10:00:00.000Z'));
    expect(me?.orgs).toEqual([{ id: 'org_1', name: 'Zernio', role: 'owner' }]);
  });

  it('returns null for unknown users', async () => {
    const { db } = createDbStub(() => ({ first: null }));
    await expect(getUserWithOrgs({ db, userId: 'nope' })).resolves.toBeNull();
  });
});
