-- Human identity. Orgs stay the tenant; users attach to orgs through
-- org_members and authenticate with password + bearer session tokens.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- Lowercased/trimmed at the op layer before insert.
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  -- "pbkdf2$<iterations>$<salt hex>$<hash hex>" (PBKDF2-SHA256). Self-
  -- describing so iteration bumps re-hash lazily on next successful login.
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_org_members_user ON org_members(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- SHA-256 hex of the sess_ bearer token; the token is shown once at login.
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
