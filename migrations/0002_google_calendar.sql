-- Additive, single-household Google integration. No existing records are changed.
-- Optional instants preserve DST-fold intervals that cannot be represented by wall-clock times alone.
ALTER TABLE events ADD COLUMN startInstant TEXT;
ALTER TABLE events ADD COLUMN endInstant TEXT;
CREATE TABLE google_connections (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  id TEXT NOT NULL UNIQUE,
  account_id TEXT,
  account_email TEXT,
  refresh_ciphertext TEXT NOT NULL,
  refresh_iv TEXT NOT NULL,
  encryption_version INTEGER NOT NULL CHECK (encryption_version = 1),
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE google_calendars (
  household_id TEXT NOT NULL REFERENCES google_connections(household_id) ON DELETE CASCADE,
  google_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  privacy_mode TEXT NOT NULL DEFAULT 'busy' CHECK (privacy_mode IN ('busy','title','full')),
  sync_token TEXT,
  window_start TEXT,
  window_end TEXT,
  sync_time_zone TEXT,
  full_synced_at TEXT,
  last_synced_at TEXT,
  PRIMARY KEY (household_id, google_id),
  UNIQUE (household_id, source_id),
  FOREIGN KEY (household_id, source_id) REFERENCES calendar_sources(household_id, id)
);
-- Future provider-neutral member mapping can reference source_id without changing events.
CREATE TABLE google_oauth_states (
  state_hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX google_oauth_expiry ON google_oauth_states(expires_at);
-- A lease serializes sync, privacy, reconnect and disconnect across Worker instances.
CREATE TABLE google_operation_locks (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- A failed CHECK fences an expired lease and rolls back the complete D1 batch.
CREATE TABLE google_commit_guards (
  owner TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
