-- Preserve the existing events table so the deployed Worker can still read it during rollout.
-- Metadata and exceptions are additive, household-scoped and cascade with their master.
CREATE TABLE local_event_metadata (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  reminderMinutes INTEGER CHECK (reminderMinutes IS NULL OR reminderMinutes BETWEEN 0 AND 40320),
  PRIMARY KEY (household_id,id),
  FOREIGN KEY (household_id,id) REFERENCES events(household_id,id) ON DELETE CASCADE
);
INSERT INTO local_event_metadata (household_id,id,createdAt,updatedAt)
SELECT household_id,id,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM events WHERE sourceId='local';
CREATE TABLE event_exceptions (
  household_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recurrence_date TEXT NOT NULL,
  cancelled INTEGER NOT NULL CHECK (cancelled IN (0,1)),
  value TEXT CHECK (value IS NULL OR json_valid(value)),
  PRIMARY KEY (household_id,event_id,recurrence_date),
  FOREIGN KEY (household_id,event_id) REFERENCES events(household_id,id) ON DELETE CASCADE,
  CHECK ((cancelled=1 AND value IS NULL) OR (cancelled=0 AND value IS NOT NULL))
);
