-- Enterprise contact requests from the landing /enterprise form. Public
-- (unauthenticated) submissions; the API route validates and rate-limits by
-- honesty (honeypot), storage here is the source of truth.
CREATE TABLE enterprise_inquiries (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  keywords_estimate TEXT,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_enterprise_inquiries_created ON enterprise_inquiries(created_at);
