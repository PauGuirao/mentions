-- Bring-your-own source credentials, per org and source (today: x bearer
-- tokens). Ingest resolves a term's token as platform secret first, then the
-- oldest-configured subscriber org's token; data stays globally deduped
-- either way (invariant: ingest once, match all tenants).
CREATE TABLE org_source_tokens (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  source TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, source)
);
CREATE INDEX idx_org_source_tokens_source ON org_source_tokens(source);
