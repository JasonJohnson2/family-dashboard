-- Additive initial schema. No sample events, chores, meals, or personal records.
PRAGMA foreign_keys = ON;

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timeZone TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO households (id, name, timeZone) VALUES ('home', 'Our Home', 'America/New_York');

CREATE TABLE members (
  household_id TEXT NOT NULL REFERENCES households(id),
  id TEXT NOT NULL, name TEXT NOT NULL, initial TEXT NOT NULL,
  color TEXT NOT NULL, tint TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);
CREATE TABLE calendar_sources (
  household_id TEXT NOT NULL REFERENCES households(id),
  id TEXT NOT NULL, name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('local','mock','icloud','google')),
  color TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);
INSERT INTO calendar_sources VALUES ('home', 'local', 'Our Home', 'local', '#278363');

CREATE TABLE events (
  household_id TEXT NOT NULL REFERENCES households(id),
  id TEXT NOT NULL, sourceId TEXT NOT NULL, externalId TEXT,
  title TEXT NOT NULL, date TEXT NOT NULL, endDate TEXT,
  startTime TEXT, endTime TEXT, allDay INTEGER NOT NULL CHECK (allDay IN (0,1)),
  timeZone TEXT NOT NULL, location TEXT, notes TEXT,
  recurrence TEXT NOT NULL CHECK (json_valid(recurrence)),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, sourceId) REFERENCES calendar_sources(household_id, id),
  UNIQUE (household_id, sourceId, externalId)
);
CREATE INDEX events_by_date ON events(household_id, date);
CREATE TABLE event_members (
  household_id TEXT NOT NULL, event_id TEXT NOT NULL, member_id TEXT NOT NULL,
  PRIMARY KEY (household_id, event_id, member_id),
  FOREIGN KEY (household_id, event_id) REFERENCES events(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, member_id) REFERENCES members(household_id, id) ON DELETE RESTRICT
);
CREATE TABLE chores (
  household_id TEXT NOT NULL REFERENCES households(id),
  id TEXT NOT NULL, title TEXT NOT NULL, dueDate TEXT NOT NULL,
  recurrence TEXT NOT NULL CHECK (json_valid(recurrence)),
  PRIMARY KEY (household_id, id)
);
CREATE INDEX chores_by_date ON chores(household_id, dueDate);
CREATE TABLE chore_members (
  household_id TEXT NOT NULL, chore_id TEXT NOT NULL, member_id TEXT NOT NULL,
  PRIMARY KEY (household_id, chore_id, member_id),
  FOREIGN KEY (household_id, chore_id) REFERENCES chores(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, member_id) REFERENCES members(household_id, id) ON DELETE RESTRICT
);
CREATE TABLE chore_completions (
  household_id TEXT NOT NULL, chore_id TEXT NOT NULL, date TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (household_id, chore_id, date),
  FOREIGN KEY (household_id, chore_id) REFERENCES chores(household_id, id) ON DELETE CASCADE
);
CREATE TABLE meals (
  household_id TEXT NOT NULL REFERENCES households(id),
  id TEXT NOT NULL, date TEXT NOT NULL, title TEXT NOT NULL, emoji TEXT NOT NULL,
  recipeId TEXT, notes TEXT,
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, date)
);
CREATE TABLE lists (
  household_id TEXT NOT NULL REFERENCES households(id),
  id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, name)
);
CREATE TABLE list_items (
  household_id TEXT NOT NULL, id TEXT NOT NULL, list_id TEXT NOT NULL,
  text TEXT NOT NULL, completed INTEGER NOT NULL CHECK (completed IN (0,1)),
  recipeId TEXT,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, list_id) REFERENCES lists(household_id, id) ON DELETE CASCADE
);
CREATE INDEX list_items_by_list ON list_items(household_id, list_id);

-- Receipts make retries safe even if a successful response is lost in transit.
CREATE TABLE mutation_receipts (
  household_id TEXT NOT NULL REFERENCES households(id),
  id TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (household_id, id)
);

-- Deliberate seed commands only; the Worker never inserts demo records on startup.
CREATE TABLE seed_history (id TEXT PRIMARY KEY, mode TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
