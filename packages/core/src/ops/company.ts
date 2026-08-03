/**
 * Org company profile. The structured fields (name, description, use cases,
 * social accounts) are the editable source of truth; every save also composes
 * the flat company_context string the classifier reads (it joins
 * orgs.company_context directly in SQL, so the composition is stored, not
 * computed on read). The raw-context accessors stay for the API/MCP surface.
 */
import type { CompanyProfile } from '../schemas';

export async function getCompanyContext(args: { db: D1Database; orgId: string }): Promise<string> {
  const row = await args.db
    .prepare('SELECT company_context FROM orgs WHERE id = ?')
    .bind(args.orgId)
    .first<{ company_context: string }>();
  return row?.company_context ?? '';
}

export async function setCompanyContext(args: {
  db: D1Database;
  orgId: string;
  context: string;
}): Promise<void> {
  await args.db
    .prepare('UPDATE orgs SET company_context = ? WHERE id = ?')
    .bind(args.context, args.orgId)
    .run();
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

interface ProfileRow {
  name: string;
  brand_name: string | null;
  description: string;
  use_cases: string;
  x_account: string | null;
  linkedin_account: string | null;
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
  const row = await args.db
    .prepare(
      'SELECT name, brand_name, description, use_cases, x_account, linkedin_account FROM orgs WHERE id = ?',
    )
    .bind(args.orgId)
    .first<ProfileRow>();
  if (!row) return null;
  return {
    name: row.brand_name ?? row.name,
    description: row.description,
    useCases: parseUseCases(row.use_cases),
    xAccount: row.x_account,
    linkedinAccount: row.linkedin_account,
  };
}

export async function setCompanyProfile(args: {
  db: D1Database;
  orgId: string;
  profile: CompanyProfile;
}): Promise<void> {
  const { db, orgId, profile } = args;
  await db
    .prepare(
      'UPDATE orgs SET brand_name = ?, description = ?, use_cases = ?, x_account = ?, linkedin_account = ?, company_context = ? WHERE id = ?',
    )
    .bind(
      profile.name,
      profile.description,
      JSON.stringify(profile.useCases),
      profile.xAccount,
      profile.linkedinAccount,
      composeCompanyContext(profile),
      orgId,
    )
    .run();
}
