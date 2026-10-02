-- Additive provider metadata only; local/Google events, auth and rewards remain untouched.
CREATE TABLE icloud_connections (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  id TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  password_iv TEXT NOT NULL,
  encryption_version INTEGER NOT NULL CHECK(encryption_version=1),
  principal_url TEXT NOT NULL,
  home_url TEXT NOT NULL,
  requires_attention INTEGER NOT NULL DEFAULT 0 CHECK(requires_attention IN(0,1))
);
CREATE TABLE icloud_calendars (
  household_id TEXT NOT NULL REFERENCES icloud_connections(household_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
  privacy_mode TEXT NOT NULL DEFAULT 'busy' CHECK(privacy_mode IN('busy','title','full')),
  supports_sync INTEGER NOT NULL DEFAULT 0 CHECK(supports_sync IN(0,1)),
  sync_token TEXT,
  window_start TEXT,
  window_end TEXT,
  sync_time_zone TEXT,
  full_synced_at TEXT,
  last_synced_at TEXT,
  last_attempt_at TEXT,
  last_sync_error TEXT CHECK(last_sync_error IN('authorization','configuration','unavailable')),
  PRIMARY KEY(household_id,source_id),
  UNIQUE(household_id,url),
  FOREIGN KEY(household_id,source_id) REFERENCES calendar_sources(household_id,id)
);
-- Source-based mapping is usable by future external providers. Roles never gate calendars.
CREATE TABLE external_calendar_members (
  household_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY(household_id,source_id),
  FOREIGN KEY(household_id,source_id) REFERENCES calendar_sources(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY(household_id,member_id) REFERENCES members(household_id,id) ON DELETE CASCADE
);
-- No raw ICS or event details: only version and projected occurrence identities.
CREATE TABLE icloud_resources (
  household_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  href TEXT NOT NULL,
  etag TEXT NOT NULL,
  event_ids TEXT NOT NULL CHECK(json_valid(event_ids)),
  PRIMARY KEY(household_id,source_id,href),
  FOREIGN KEY(household_id,source_id) REFERENCES icloud_calendars(household_id,source_id) ON DELETE CASCADE
);
CREATE TABLE icloud_operation_locks (
  household_id TEXT PRIMARY KEY REFERENCES households(id), owner TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE icloud_commit_guards (owner TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
