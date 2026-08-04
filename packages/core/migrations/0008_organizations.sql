-- Better Auth organization plugin, mapped onto the core tenancy tables
-- (orgs, org_members stay OURS; the plugin manages membership lifecycle on
-- top). Only `invitation` is a plugin-owned table, so it follows Better
-- Auth's camelCase convention like the 0003 identity tables.

-- The plugin's organization model needs slug (unique) and metadata.
ALTER TABLE orgs ADD COLUMN slug TEXT;
ALTER TABLE orgs ADD COLUMN metadata TEXT;
UPDATE orgs SET slug = 'org-' || substr(id, 5, 16) WHERE slug IS NULL;
CREATE UNIQUE INDEX idx_orgs_slug ON orgs(slug);

-- Rebuild org_members with a surrogate id PK (the plugin's member model
-- requires one; SQLite cannot add a PK in place). Nothing references
-- org_members, so drop-and-swap is FK-safe. Role gains 'admin' (plugin
-- default role set is owner/admin/member).
CREATE TABLE org_members_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','member')),
  created_at INTEGER NOT NULL,
  UNIQUE(org_id, user_id)
);
INSERT INTO org_members_new (id, org_id, user_id, role, created_at)
  SELECT 'mem_' || lower(hex(randomblob(16))), org_id, user_id, role, created_at
  FROM org_members;
DROP TABLE org_members;
ALTER TABLE org_members_new RENAME TO org_members;
CREATE INDEX idx_org_members_user ON org_members(user_id);

-- The plugin stores the session's current workspace here.
ALTER TABLE "session" ADD COLUMN "activeOrganizationId" text;

-- Plugin-owned invitations.
create table "invitation" (
  "id" text not null primary key,
  "organizationId" text not null references orgs (id),
  "email" text not null,
  "role" text,
  "status" text not null default 'pending',
  "expiresAt" date not null,
  "inviterId" text not null references "user" ("id") on delete cascade,
  "createdAt" date
);
create index "invitation_organizationId_idx" on "invitation" ("organizationId");
create index "invitation_email_idx" on "invitation" ("email");
