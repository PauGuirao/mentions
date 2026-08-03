-- Structured company profile (name lives in brand_name from 0004). The
-- classifier keeps reading the composed company_context string; the profile
-- fields are its editable source of truth.
ALTER TABLE orgs ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE orgs ADD COLUMN use_cases TEXT NOT NULL DEFAULT '[]';
ALTER TABLE orgs ADD COLUMN x_account TEXT;
ALTER TABLE orgs ADD COLUMN linkedin_account TEXT;

-- Existing orgs: the old free-text context is the closest thing to a description.
UPDATE orgs SET description = company_context;
