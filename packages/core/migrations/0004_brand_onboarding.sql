-- Brand profile captured during onboarding. onboarded_at NULL means the org
-- still has to go through the onboarding flow; existing orgs are backfilled.
ALTER TABLE orgs ADD COLUMN website TEXT;
ALTER TABLE orgs ADD COLUMN brand_name TEXT;
ALTER TABLE orgs ADD COLUMN logo_url TEXT;
ALTER TABLE orgs ADD COLUMN onboarded_at INTEGER;

UPDATE orgs SET onboarded_at = created_at;
