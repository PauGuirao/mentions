import { describe, expect, it } from 'vitest';
import { bootstrapOrgForUser, getOrgForUser, getUserWithOrgs, isOrgMember, listOrgsForUser } from '../org-members';
import { createTestD1, seedUser } from './d1-sqlite';

describe('bootstrapOrgForUser', () => {
  it('creates an org and owner membership named from the email localpart', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    const result = await bootstrapOrgForUser({ db, userId: 'u1', email: 'pau@zernio.com' });

    expect(result.created).toBe(true);
    expect(result.orgId).toMatch(/^org_/);
    const orgs = await listOrgsForUser({ db, userId: 'u1' });
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ id: result.orgId, name: "pau's workspace", role: 'owner' });
  });

  it('is idempotent: a second call returns the existing org', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    const first = await bootstrapOrgForUser({ db, userId: 'u1', email: 'a@b.co' });
    const second = await bootstrapOrgForUser({ db, userId: 'u1', email: 'a@b.co' });
    expect(second).toEqual({ orgId: first.orgId, created: false });
    await expect(listOrgsForUser({ db, userId: 'u1' })).resolves.toHaveLength(1);
  });
});

describe('getOrgForUser', () => {
  it('returns the oldest membership org, or null', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    await db
      .prepare(
        `INSERT INTO orgs (id, name, created_at) VALUES ('org_new', 'new', 0), ('org_old', 'old', 0)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES
         ('org_new', 'u1', 'member', 200), ('org_old', 'u1', 'owner', 100)`,
      )
      .run();
    await expect(getOrgForUser({ db, userId: 'u1' })).resolves.toBe('org_old');
    await expect(getOrgForUser({ db, userId: 'nobody' })).resolves.toBeNull();
  });
});

describe('getUserWithOrgs', () => {
  it('normalizes ISO-string createdAt from the Better Auth table to epoch ms', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    const { orgId } = await bootstrapOrgForUser({ db, userId: 'u1', email: 'u1@example.com' });
    await db
      .prepare("UPDATE orgs SET website = 'https://zernio.com', brand_name = 'Zernio', onboarded_at = 5 WHERE id = ?1")
      .bind(orgId)
      .run();

    const me = await getUserWithOrgs({ db, userId: 'u1' });
    expect(me?.user).toEqual({
      id: 'u1',
      email: 'u1@example.com',
      name: 'user u1',
      createdAt: Date.parse('2026-07-18T10:00:00.000Z'),
    });
    expect(me?.orgs).toEqual([
      {
        id: orgId,
        name: "u1's workspace",
        role: 'owner',
        website: 'https://zernio.com',
        brandName: 'Zernio',
        logoUrl: null,
        onboarded: true,
      },
    ]);
  });

  it('returns null for unknown users', async () => {
    const db = createTestD1();
    await expect(getUserWithOrgs({ db, userId: 'nope' })).resolves.toBeNull();
  });
});

describe('isOrgMember', () => {
  it('is true only for actual memberships (guards stale active-org pointers)', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    await seedUser(db, 'u2');
    const { orgId } = await bootstrapOrgForUser({ db, userId: 'u1', email: 'u1@example.com' });

    expect(await isOrgMember({ db, userId: 'u1', orgId })).toBe(true);
    expect(await isOrgMember({ db, userId: 'u2', orgId })).toBe(false);
    expect(await isOrgMember({ db, userId: 'u1', orgId: 'org_missing' })).toBe(false);
  });
});

describe('bootstrapOrgForUser (organization plugin fields)', () => {
  it('writes a slug and a surrogate member id', async () => {
    const db = createTestD1();
    await seedUser(db, 'u1');
    const { orgId } = await bootstrapOrgForUser({ db, userId: 'u1', email: 'u1@example.com' });

    const org = await db.prepare('SELECT slug FROM orgs WHERE id = ?1').bind(orgId).first<{ slug: string }>();
    expect(org?.slug).toMatch(/^org-/);
    const member = await db
      .prepare('SELECT id, role FROM org_members WHERE org_id = ?1')
      .bind(orgId)
      .first<{ id: string; role: string }>();
    expect(member?.id).toMatch(/^mem_/);
    expect(member?.role).toBe('owner');
  });
});
