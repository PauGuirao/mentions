/** Org lifecycle. MVP: creation only (plan and company_context use SQL defaults). */
import { newId } from '../ids';

export async function createOrg(args: { db: D1Database; name: string }): Promise<{ id: string }> {
  const id = newId('org');
  await args.db
    .prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)')
    .bind(id, args.name, Date.now())
    .run();
  return { id };
}
