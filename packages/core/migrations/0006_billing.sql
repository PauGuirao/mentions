-- Billing: D1 is the metering source of truth; Polar is a projection fed by
-- an idempotent flush (deterministic event external_ids). Model:
--   keyword line  = max active keywords in the cycle (Polar meter: Max)
--   mention line  = whole 1k-units of relevant mentions past the pooled
--                   allowance (500 x keyword_max); remainder is forgiven at
--                   cycle end. Filtered/noise mentions are NEVER billable.

CREATE TABLE org_billing (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  polar_customer_id TEXT,
  polar_subscription_id TEXT,
  -- none = never subscribed (free tier); statuses mirror Polar's subscription
  -- lifecycle collapsed to what gating needs.
  status TEXT NOT NULL DEFAULT 'none'
    CHECK (status IN ('none','active','past_due','canceled')),
  current_period_start INTEGER,
  current_period_end INTEGER,
  updated_at INTEGER NOT NULL
);

-- One row per org per calendar-month UTC cycle ('YYYY-MM'). Usage accrues
-- here all cycle; NOTHING is sent to Polar until the cycle closes (the
-- settlement pass), so every number is final when it becomes an event and
-- retroactive pool growth can never over-bill.
CREATE TABLE usage_cycles (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  cycle TEXT NOT NULL,
  relevant_mentions INTEGER NOT NULL DEFAULT 0,
  -- High-water mark of active (unmuted) keywords this cycle; both the
  -- keyword bill line and the mention pool derive from it. Maintained by
  -- keyword ops, the mention counter AND a scheduler heartbeat (a quiet
  -- month with no writes must still bill its keywords).
  keyword_max INTEGER NOT NULL DEFAULT 0,
  -- 1k-units already projected to Polar; settlement advances this only
  -- after a successful ingest, so a crash re-sends (deduped by external_id).
  billed_units INTEGER NOT NULL DEFAULT 0,
  -- Set when the closed cycle's events were ingested; NULL = not settled.
  settled_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, cycle)
);

-- Ledger making mention counting idempotent across queue redeliveries: one
-- row per billable match, ever. The PK is the dedupe.
CREATE TABLE billable_mentions (
  mention_match_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  cycle TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_billable_org_cycle ON billable_mentions(org_id, cycle);
