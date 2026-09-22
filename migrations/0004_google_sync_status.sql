-- Durable automatic-sync cooldown and sanitized status. Existing connections/imports are untouched.
ALTER TABLE google_calendars ADD COLUMN last_attempt_at TEXT;
ALTER TABLE google_calendars ADD COLUMN last_sync_error TEXT CHECK (
  last_sync_error IS NULL OR last_sync_error IN ('authorization','configuration','unavailable')
);
