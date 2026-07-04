-- Mentions MVP schema. D1 (SQLite).
-- Global vs tenant split: `mentions` is deduped world data; `mention_matches`
-- is the tenant-scoped row every user-facing query hangs off.

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  -- Free-text company context fed to the classifier; the single biggest
  -- relevance lever, so it lives on the org, editable via API.
  company_context TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  -- SHA-256 hex of the full key; the key itself is shown once at mint.
  key_hash TEXT NOT NULL UNIQUE,
  -- First 8 chars kept for display ("sk_live_ab12...").
  prefix TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_api_keys_org ON api_keys(org_id);

CREATE TABLE keywords (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  term TEXT NOT NULL,
  -- Lowercased/trimmed form used for matching AND for the deduped term
  -- registry (search-API sources poll per DISTINCT normalized_term).
  normalized_term TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'brand' CHECK (kind IN ('brand','competitor','topic')),
  muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(org_id, normalized_term)
);
CREATE INDEX idx_keywords_norm ON keywords(normalized_term) WHERE muted = 0;

CREATE TABLE mentions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT,
  author_url TEXT,
  -- Matched text (post/comment/title+body). Truncated at ingest to 8KB;
  -- full raw payload lives in R2 under raw_r2_key.
  text TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  raw_r2_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(source, external_id)
);
CREATE INDEX idx_mentions_published ON mentions(published_at);

CREATE TABLE mention_matches (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mention_id TEXT NOT NULL REFERENCES mentions(id),
  keyword_id TEXT NOT NULL REFERENCES keywords(id),
  -- matched -> classified -> (delivered) ; filtered = classifier scored it
  -- below the org threshold (kept queryable, never delivered).
  state TEXT NOT NULL DEFAULT 'matched'
    CHECK (state IN ('matched','classified','filtered','delivered','ignored','done')),
  relevance INTEGER,           -- 0-100, null until classified
  sentiment TEXT CHECK (sentiment IN ('positive','neutral','negative') OR sentiment IS NULL),
  intents TEXT,                -- JSON array: buy_intent, question, complaint, ...
  ai_note TEXT,                -- one-line explanation
  created_at INTEGER NOT NULL,
  UNIQUE(org_id, mention_id, keyword_id)
);
CREATE INDEX idx_matches_org_created ON mention_matches(org_id, created_at DESC);
CREATE INDEX idx_matches_org_state ON mention_matches(org_id, state);

CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  -- JSON FeedFilter: { keywordIds?, sources?, minRelevance?, sentiments?, intents? }
  filter TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feeds_org ON feeds(org_id);

CREATE TABLE destinations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL CHECK (type IN ('webhook','slack')),
  -- JSON per type: webhook {url, secret} | slack {botToken, channel}
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE feed_destinations (
  feed_id TEXT NOT NULL REFERENCES feeds(id),
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  PRIMARY KEY (feed_id, destination_id)
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  mention_match_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(destination_id, mention_match_id)
);

CREATE TABLE cursors (
  source TEXT NOT NULL,
  -- '' for firehose/global sources; the normalized term for per-term polling.
  term TEXT NOT NULL DEFAULT '',
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, term)
);
