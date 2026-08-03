/**
 * Org membership for Better Auth users. Identity (user/session/account
 * tables) is owned by Better Auth inside the API worker; THIS is the seam
 * where a user becomes a tenant: every user gets a workspace org through
 * org_members, and org-scoped ops only ever see the orgId.
 */
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

  const existing = await db
    .prepare('SELECT org_id FROM org_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
    .bind(userId)
    .first<{ org_id: string }>();
  if (existing) return { orgId: existing.org_id, created: false };

  const orgId = newId('org');
  const orgName = args.orgName?.trim() || `${email.split('@')[0]}'s workspace`;
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').bind(orgId, orgName, now),
    db
      .prepare('INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .bind(orgId, userId, 'owner', now),
  ]);
  return { orgId, created: true };
}

/** The org a session acts on: oldest membership wins (MVP: one org/user). */
export async function getOrgForUser(args: { db: D1Database; userId: string }): Promise<string | null> {
  const row = await args.db
    .prepare('SELECT org_id FROM org_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
    .bind(args.userId)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

interface OrgSummaryRow {
  id: string;
  name: string;
  role: 'owner' | 'member';
  website: string | null;
  brand_name: string | null;
  logo_url: string | null;
  onboarded_at: number | null;
}

export async function listOrgsForUser(args: {
  db: D1Database;
  userId: string;
}): Promise<OrgSummary[]> {
  const { results } = await args.db
    .prepare(
      `SELECT o.id, o.name, om.role, o.website, o.brand_name, o.logo_url, o.onboarded_at
       FROM org_members om
       JOIN orgs o ON o.id = om.org_id
       WHERE om.user_id = ? ORDER BY om.created_at ASC`,
    )
    .bind(args.userId)
    .all<OrgSummaryRow>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    website: row.website,
    brandName: row.brand_name,
    logoUrl: row.logo_url,
    onboarded: row.onboarded_at !== null,
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
