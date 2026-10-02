-- Roles are classifications, not authentication or operator authorization.
-- No inference from names or history; preserve all ledger and recipient rows.
ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'adult' CHECK (role IN ('adult','child'));
