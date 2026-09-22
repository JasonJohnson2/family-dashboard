-- At most one existing household member per Google calendar. Existing calendars remain unassigned.
CREATE TABLE google_calendar_members (
  household_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (household_id, source_id),
  FOREIGN KEY (household_id, source_id) REFERENCES google_calendars(household_id, source_id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, member_id) REFERENCES members(household_id, id) ON DELETE RESTRICT
);
CREATE INDEX google_calendars_by_member ON google_calendar_members(household_id, member_id);

-- An old Worker finishing an in-flight sync cannot mark the new projection as complete.
ALTER TABLE google_calendars ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 0 CHECK (projection_version IN (0,1));

-- Old projections did not retain Google's event type. Re-read once to remove unchanged
-- working-location occurrences without guessing from titles or discarding OAuth connections.
-- Keep displayed data until a complete replacement sync succeeds.
UPDATE google_calendars SET sync_token=NULL, full_synced_at=NULL;
