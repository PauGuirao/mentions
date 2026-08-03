-- One Slack workspace connection per org, installed via OAuth v2. The managed
-- "Slack notifications" feed + destination pair (created when the user picks
-- a channel) is tracked here so re-installs can refresh the stored bot token
-- and disconnect can tear the whole thing down as one unit. minRelevance is
-- NOT duplicated here: the feed's filter JSON stays the single source of
-- truth for what gets delivered.
CREATE TABLE slack_installs (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  bot_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  -- Managed notification wiring; all NULL until the user picks a channel.
  feed_id TEXT REFERENCES feeds(id),
  destination_id TEXT REFERENCES destinations(id),
  channel_id TEXT,
  channel_name TEXT
);
