-- Self-serve trial: new signups get a 3-day / 100-relevant-mention trial
-- before a card is required. NULL = grandfathered org (pre-trial signup or
-- legacy free), which keeps today's behavior. Trial expiry is enforced by
-- the scheduler muting the org's keywords (full stop); upgrading unmutes.
ALTER TABLE orgs ADD COLUMN trial_ends_at INTEGER;
