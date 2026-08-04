/**
 * Org membership for Better Auth users. Identity (user/session/account
 * tables) is owned by Better Auth inside the API worker; THIS is the seam
 * where a user becomes a tenant: every user gets a workspace org through
 * org_members, and org-scoped ops only ever see the orgId.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { orgMembers, orgs } from '../db/schema';
import { newId } from '../ids';
import type { OrgSummary, User } from '../schemas';

/** Auto-provision a workspace for a fresh signup (Better Auth user.create
 *  hook). Safe to call twice: bails if the user already has a membership. */
export async function bootstrapOrgForUser(args: {
  db: D1Database;
  userId: string;
  email: string;
  orgName?: string;
}): Promise<{ orgId: string; created: boolean }> {
  const { db, userId, email } = args;
  const orm = getDb(db);

  const existing = await getOrgForUser({ db, userId });
  if (existing) return { orgId: existing, created: false };

  const orgId = newId('org');
  const orgName = args.orgName?.trim() || `${email.split('@')[0]}'s workspace`;
  const now = Date.now();
  await orm.batch([
    // Slug mirrors the 0008 backfill shape; the org plugin requires one.
    orm.insert(orgs).values({ id: orgId, name: orgName, slug: `org-${orgId.slice(4, 20)}`, createdAt: now }),
    orm.insert(orgMembers).values({ id: newId('mem'), orgId, userId, role: 'owner', createdAt: now }),
  ]);
  return { orgId, created: true };
}

/** Membership check for the auth middleware's active-org resolution: a
 *  stale activeOrganizationId (member removed) must not grant access. */
export async function isOrgMember(args: {
  db: D1Database;
  userId: string;
  orgId: string;
}): Promise<boolean> {
  const row = await getDb(args.db)
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, args.userId), eq(orgMembers.orgId, args.orgId)))
    .limit(1)
    .get();
  return row !== undefined;
}

/** The org a session acts on: oldest membership wins (MVP: one org/user). */
export async function getOrgForUser(args: { db: D1Database; userId: string }): Promise<string | null> {
  const row = await getDb(args.db)
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, args.userId))
    .orderBy(asc(orgMembers.createdAt))
    .limit(1)
    .get();
  return row?.orgId ?? null;
}

export async function listOrgsForUser(args: {
  db: D1Database;
  userId: string;
}): Promise<OrgSummary[]> {
  const rows = await getDb(args.db)
    .select({
      id: orgs.id,
      name: orgs.name,
      role: orgMembers.role,
      website: orgs.website,
      brandName: orgs.brandName,
      logoUrl: orgs.logoUrl,
      onboardedAt: orgs.onboardedAt,
    })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, args.userId))
    .orderBy(asc(orgMembers.createdAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    website: row.website,
    brandName: row.brandName,
    logoUrl: row.logoUrl,
    onboarded: row.onboardedAt !== null,
  }));
}

interface BetterAuthUserRow {
  id: string;
  email: string;
  name: string;
  createdAt: number | string;
}

/** Better Auth's kysely adapter stores dates in a "date" column; D1 hands
 *  them back as ISO strings (or ms if written raw). Normalize to epoch ms. */
const toEpochMs = (value: number | string): number =>
  typeof value === 'number' ? value : new Date(value).getTime();

export async function getUserWithOrgs(args: {
  db: D1Database;
  userId: string;
}): Promise<{
  user: User;
  orgs: OrgSummary[];
} | null> {
  const { db, userId } = args;
  // Better Auth's "user" table is deliberately outside the drizzle schema
  // (Better Auth owns its shape), so this one read stays raw.
  const row = await db
    .prepare('SELECT id, email, name, "createdAt" FROM "user" WHERE id = ?')
    .bind(userId)
    .first<BetterAuthUserRow>();
  if (!row) return null;

  const orgs = await listOrgsForUser({ db, userId });
  return {
    user: { id: row.id, email: row.email, name: row.name, createdAt: toEpochMs(row.createdAt) },
    orgs,
  };
}
