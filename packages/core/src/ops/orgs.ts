/** Org lifecycle. MVP: creation only (plan and company_context use SQL defaults). */
import { getDb } from '../db/client';
import { orgs } from '../db/schema';
import { newId } from '../ids';

export async function createOrg(args: { db: D1Database; name: string }): Promise<{ id: string }> {
  const id = newId('org');
  await getDb(args.db).insert(orgs).values({ id, name: args.name, createdAt: Date.now() });
  return { id };
}
