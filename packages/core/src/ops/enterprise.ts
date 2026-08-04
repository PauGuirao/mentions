/**
 * Enterprise contact requests: stored in D1 as the source of truth; the API
 * route additionally sends a best-effort notification email when Resend is
 * configured.
 */
import { getDb } from '../db/client';
import { enterpriseInquiries } from '../db/schema';
import { newId } from '../ids';

export async function createEnterpriseInquiry(args: {
  db: D1Database;
  company: string;
  name: string;
  email: string;
  keywordsEstimate?: string | undefined;
  message?: string | undefined;
  nowMs?: number;
}): Promise<{ id: string }> {
  const id = newId('enq');
  await getDb(args.db)
    .insert(enterpriseInquiries)
    .values({
      id,
      company: args.company,
      name: args.name,
      email: args.email,
      keywordsEstimate: args.keywordsEstimate ?? null,
      message: args.message ?? null,
      createdAt: args.nowMs ?? Date.now(),
    });
  return { id };
}
