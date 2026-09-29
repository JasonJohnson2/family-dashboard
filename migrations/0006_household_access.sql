-- Additive: no household records or existing Google credentials are changed.
CREATE TABLE household_credentials (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  verifier TEXT NOT NULL, version TEXT NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE household_sessions (
  household_id TEXT NOT NULL REFERENCES households(id), id TEXT NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE, credentialVersion TEXT NOT NULL,
  name TEXT NOT NULL, trusted INTEGER NOT NULL CHECK (trusted IN (0,1)),
  createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, revokedAt INTEGER,
  PRIMARY KEY (household_id,id)
);
CREATE INDEX household_session_expiry ON household_sessions(household_id,expiresAt);
CREATE TABLE household_login_attempts (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  attempts INTEGER NOT NULL, windowStart INTEGER NOT NULL
);
ALTER TABLE reward_operator_sessions ADD COLUMN householdSessionId TEXT;
ALTER TABLE google_oauth_states ADD COLUMN household_session_id TEXT;
