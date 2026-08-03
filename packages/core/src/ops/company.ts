/**
 * Org company profile. The structured fields (name, description, use cases,
 * social accounts) are the editable source of truth; every save also composes
 * the flat company_context string the classifier reads (it joins
 * orgs.company_context directly in SQL, so the composition is stored, not
 * computed on read). The raw-context accessors stay for the API/MCP surface.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { orgs } from '../db/schema';
import type { CompanyProfile } from '../schemas';

export async function getCompanyContext(args: { db: D1Database; orgId: string }): Promise<string> {
  const row = await getDb(args.db)
    .select({ companyContext: orgs.companyContext })
    .from(orgs)
    .where(eq(orgs.id, args.orgId))
    .get();
  return row?.companyContext ?? '';
}

export async function setCompanyContext(args: {
  db: D1Database;
  orgId: string;
  context: string;
}): Promise<void> {
  await getDb(args.db).update(orgs).set({ companyContext: args.context }).where(eq(orgs.id, args.orgId));
}

/** The flat classifier context derived from a structured profile. */
export function composeCompanyContext(profile: CompanyProfile): string {
  const parts: string[] = [];
  const intro = profile.description.trim();
  parts.push(intro === '' ? profile.name : `${profile.name}: ${intro}`);

  const useCases = profile.useCases.map((u) => u.trim()).filter((u) => u !== '');
  if (useCases.length > 0) {
    parts.push(['Product use cases:', ...useCases.map((u) => `- ${u}`)].join('\n'));
  }

  const socials: string[] = [];
  if (profile.xAccount) socials.push(`X/Twitter: @${profile.xAccount.replace(/^@/, '')}`);
  if (profile.linkedinAccount) socials.push(`LinkedIn: ${profile.linkedinAccount}`);
  if (socials.length > 0) parts.push(socials.join('\n'));

  return parts.join('\n\n');
}

const parseUseCases = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
};

export async function getCompanyProfile(args: {
  db: D1Database;
  orgId: string;
}): Promise<CompanyProfile | null> {
  const row = await getDb(args.db)
    .select({
      name: orgs.name,
      brandName: orgs.brandName,
      description: orgs.description,
      useCases: orgs.useCases,
      xAccount: orgs.xAccount,
      linkedinAccount: orgs.linkedinAccount,
    })
    .from(orgs)
    .where(eq(orgs.id, args.orgId))
    .get();
  if (!row) return null;
  return {
    name: row.brandName ?? row.name,
    description: row.description,
    useCases: parseUseCases(row.useCases),
    xAccount: row.xAccount,
    linkedinAccount: row.linkedinAccount,
  };
}

export async function setCompanyProfile(args: {
  db: D1Database;
  orgId: string;
  profile: CompanyProfile;
}): Promise<void> {
  const { db, orgId, profile } = args;
  await getDb(db)
    .update(orgs)
    .set({
      brandName: profile.name,
      description: profile.description,
      useCases: JSON.stringify(profile.useCases),
      xAccount: profile.xAccount,
      linkedinAccount: profile.linkedinAccount,
      companyContext: composeCompanyContext(profile),
    })
    .where(eq(orgs.id, orgId));
}
