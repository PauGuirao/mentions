/**
 * User lifecycle: self-serve signup (user + workspace org + owner membership,
 * one transactional batch) and password login that mints a session. Orgs stay
 * the tenant; a user reaches org data only through org_members.
 */
import { newId } from '../ids';
import type { User } from '../schemas';
import { hashPassword, verifyPassword } from './passwords';
import { createSession } from './sessions';

/** Thrown when the email is already registered. */
export class DuplicateUserError extends Error {
  constructor(email: string) {
    super(`An account for "${email}" already exists`);
    this.name = 'DuplicateUserError';
  }
}

/** Thrown on unknown email or wrong password; deliberately indistinguishable. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: number;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  createdAt: row.created_at,
});

export async function signup(args: {
  db: D1Database;
  email: string;
  password: string;
  name?: string;
  orgName?: string;
}): Promise<{ user: User; orgId: string; session: { token: string; expiresAt: number } }> {
  const { db, password } = args;
  const email = normalizeEmail(args.email);
  const name = args.name?.trim() ?? '';
  const orgName = args.orgName?.trim() || `${email.split('@')[0]}'s workspace`;

  const userId = newId('usr');
  const orgId = newId('org');
  const now = Date.now();
  const passwordHash = await hashPassword(password);

  try {
    await db.batch([
      db
        .prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, email, name, passwordHash, now),
      db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').bind(orgId, orgName, now),
      db
        .prepare('INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .bind(orgId, userId, 'owner', now),
    ]);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw new DuplicateUserError(email);
    }
    throw err;
  }

  const session = await createSession({ db, userId });
  return { user: { id: userId, email, name, createdAt: now }, orgId, session };
}

export async function login(args: {
  db: D1Database;
  email: string;
  password: string;
}): Promise<{ user: User; session: { token: string; expiresAt: number } }> {
  const { db, password } = args;
  const email = normalizeEmail(args.email);

  const row = await db
    .prepare('SELECT id, email, name, password_hash, created_at FROM users WHERE email = ?')
    .bind(email)
    .first<UserRow>();
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new InvalidCredentialsError();
  }

  const session = await createSession({ db, userId: row.id });
  return { user: toUser(row), session };
}

export async function getUserWithOrgs(args: {
  db: D1Database;
  userId: string;
}): Promise<{ user: User; orgs: Array<{ id: string; name: string; role: 'owner' | 'member' }> } | null> {
  const { db, userId } = args;
  const row = await db
    .prepare('SELECT id, email, name, password_hash, created_at FROM users WHERE id = ?')
    .bind(userId)
    .first<UserRow>();
  if (!row) return null;

  const { results } = await db
    .prepare(
      `SELECT o.id, o.name, om.role FROM org_members om
       JOIN orgs o ON o.id = om.org_id
       WHERE om.user_id = ? ORDER BY om.created_at ASC`,
    )
    .bind(userId)
    .all<{ id: string; name: string; role: 'owner' | 'member' }>();

  return { user: toUser(row), orgs: results };
}
