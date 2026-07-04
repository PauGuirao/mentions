/**
 * Org company context: free text fed verbatim to the classifier. The single
 * biggest relevance lever, so it is editable via API.
 */

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
