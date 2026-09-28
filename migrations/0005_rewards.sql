-- Additive Rewards V1. Existing completions earn no retroactive stars.
ALTER TABLE chores ADD COLUMN stars INTEGER NOT NULL DEFAULT 0 CHECK (stars BETWEEN 0 AND 1000);

CREATE TABLE rewards (
  household_id TEXT NOT NULL REFERENCES households(id), id TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL,
  starCost INTEGER NOT NULL CHECK (starCost BETWEEN 1 AND 100000),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  reusable INTEGER NOT NULL CHECK (reusable IN (0,1)),
  requiresApproval INTEGER NOT NULL CHECK (requiresApproval IN (0,1)),
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  PRIMARY KEY (household_id,id)
);
CREATE TABLE reward_members (
  household_id TEXT NOT NULL, reward_id TEXT NOT NULL, member_id TEXT NOT NULL,
  PRIMARY KEY (household_id,reward_id,member_id),
  FOREIGN KEY (household_id,reward_id) REFERENCES rewards(household_id,id) ON DELETE CASCADE,
  FOREIGN KEY (household_id,member_id) REFERENCES members(household_id,id) ON DELETE RESTRICT
);
CREATE TABLE reward_redemptions (
  household_id TEXT NOT NULL, id TEXT NOT NULL, rewardId TEXT NOT NULL, memberId TEXT NOT NULL,
  name TEXT NOT NULL, starCost INTEGER NOT NULL CHECK (starCost > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','redeemed','declined')),
  oneTime INTEGER NOT NULL CHECK (oneTime IN (0,1)),
  createdAt TEXT NOT NULL, resolvedAt TEXT,
  PRIMARY KEY (household_id,id),
  FOREIGN KEY (household_id,rewardId) REFERENCES rewards(household_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id,memberId) REFERENCES members(household_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX reward_pending_once ON reward_redemptions(household_id,rewardId,memberId) WHERE status='pending';
CREATE UNIQUE INDEX reward_one_time ON reward_redemptions(household_id,rewardId,memberId) WHERE status='redeemed' AND oneTime=1;
CREATE INDEX redemption_member ON reward_redemptions(household_id,memberId,createdAt);

-- Retained even after undo. Each completion cycle has its own identity.
CREATE TABLE chore_star_awards (
  household_id TEXT NOT NULL, id TEXT NOT NULL, choreId TEXT NOT NULL,
  date TEXT NOT NULL, memberId TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000),
  reversedAt TEXT,
  PRIMARY KEY (household_id,id),
  FOREIGN KEY (household_id,choreId) REFERENCES chores(household_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id,memberId) REFERENCES members(household_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX chore_active_award ON chore_star_awards(household_id,choreId,date) WHERE reversedAt IS NULL;
CREATE TABLE star_transactions (
  household_id TEXT NOT NULL, id TEXT NOT NULL, memberId TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount != 0 AND amount BETWEEN -100000 AND 100000),
  type TEXT NOT NULL CHECK (type IN ('chore_completion','chore_reversal','reward_redemption','manual_adjustment')),
  choreId TEXT, choreCompletionId TEXT, rewardId TEXT, redemptionId TEXT,
  note TEXT NOT NULL, createdAt TEXT NOT NULL,
  PRIMARY KEY (household_id,id),
  FOREIGN KEY (household_id,memberId) REFERENCES members(household_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id,choreId) REFERENCES chores(household_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id,choreCompletionId) REFERENCES chore_star_awards(household_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id,rewardId) REFERENCES rewards(household_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id,redemptionId) REFERENCES reward_redemptions(household_id,id) ON DELETE RESTRICT,
  UNIQUE (household_id,choreCompletionId,type),
  UNIQUE (household_id,redemptionId)
);
CREATE INDEX stars_by_member ON star_transactions(household_id,memberId,createdAt);

-- Operator tokens are random, hashed at rest, and never part of household state.
CREATE TABLE reward_operator_sessions (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  tokenHash TEXT NOT NULL, expiresAt INTEGER NOT NULL
);
CREATE TABLE reward_pin_attempts (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  attempts INTEGER NOT NULL, windowStart INTEGER NOT NULL
);
