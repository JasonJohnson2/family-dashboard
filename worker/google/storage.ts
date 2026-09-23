import { ApiError, HOUSEHOLD_ID } from '../database';
import type { Connection, StoredCalendar } from './types';

export const connection = (db: D1Database) =>
  db
    .prepare('SELECT * FROM google_connections WHERE household_id=?')
    .bind(HOUSEHOLD_ID)
    .first<Connection>();
export const calendars = async (db: D1Database) =>
  (
    await db
      .prepare(
        'SELECT c.*,m.member_id FROM google_calendars c LEFT JOIN google_calendar_members m ON m.household_id=c.household_id AND m.source_id=c.source_id WHERE c.household_id=? ORDER BY c.name,c.google_id',
      )
      .bind(HOUSEHOLD_ID)
      .all<StoredCalendar>()
  ).results;
// Only change assignments that differ; unchanged member rows are never rewritten.
// Only persisted events belonging to this source are touched, even if a provider ID collides.
export function assignImportedEvents(db: D1Database, sourceId: string, memberId: string | null) {
  return [
    db
      .prepare(
        'DELETE FROM event_members WHERE household_id=? AND member_id IS NOT ? AND event_id IN (SELECT id FROM events WHERE household_id=? AND sourceId=?)',
      )
      .bind(HOUSEHOLD_ID, memberId, HOUSEHOLD_ID, sourceId),
    ...(memberId
      ? [
          db
            .prepare(
              'INSERT INTO event_members (household_id,event_id,member_id) SELECT e.household_id,e.id,? FROM events e WHERE e.household_id=? AND e.sourceId=? AND NOT EXISTS (SELECT 1 FROM event_members m WHERE m.household_id=e.household_id AND m.event_id=e.id AND m.member_id=?)',
            )
            .bind(memberId, HOUSEHOLD_ID, sourceId, memberId),
        ]
      : []),
  ];
}
// Delete mappings before sources to honor their FK, while retaining the exact owned source IDs.
export async function disconnectStatements(db: D1Database) {
  const owned = (await calendars(db)).map((c) => c.source_id);
  return [
    db
      .prepare(
        'DELETE FROM events WHERE household_id=? AND sourceId IN (SELECT value FROM json_each(?))',
      )
      .bind(HOUSEHOLD_ID, JSON.stringify(owned)),
    db.prepare('DELETE FROM google_connections WHERE household_id=?').bind(HOUSEHOLD_ID),
    db
      .prepare(
        "DELETE FROM calendar_sources WHERE household_id=? AND provider='google' AND id IN (SELECT value FROM json_each(?))",
      )
      .bind(HOUSEHOLD_ID, JSON.stringify(owned)),
    db.prepare('DELETE FROM google_oauth_states WHERE household_id=?').bind(HOUSEHOLD_ID),
  ];
}
export interface Lease {
  db: D1Database;
  owner: string;
}
export async function withLease<T>(db: D1Database, fn: (lease: Lease) => Promise<T>) {
  const owner = crypto.randomUUID(),
    now = Date.now();
  const result = await db
    .prepare(
      'INSERT INTO google_operation_locks (household_id,owner,expires_at) VALUES (?,?,?) ON CONFLICT(household_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE google_operation_locks.expires_at<=?',
    )
    .bind(HOUSEHOLD_ID, owner, now + 120000, now)
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(
      409,
      'Another Google operation is running. Try again shortly.',
      'google_busy',
    );
  try {
    return await fn({ db, owner });
  } finally {
    await db
      .prepare('DELETE FROM google_operation_locks WHERE household_id=? AND owner=?')
      .bind(HOUSEHOLD_ID, owner)
      .run();
  }
}
export async function commit(lease: Lease, statements: D1PreparedStatement[], revise = true) {
  const { db, owner } = lease;
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO google_commit_guards (owner,valid) VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM google_operation_locks WHERE household_id=? AND owner=? AND expires_at>?) THEN 1 ELSE 0 END)',
        )
        .bind(owner, HOUSEHOLD_ID, owner, Date.now()),
      ...statements,
      ...(revise
        ? [db.prepare('UPDATE households SET revision=revision+1 WHERE id=?').bind(HOUSEHOLD_ID)]
        : []),
      db.prepare('DELETE FROM google_commit_guards WHERE owner=?').bind(owner),
    ]);
  } catch {
    throw new ApiError(
      503,
      'Google changes could not be committed. Nothing in this batch was saved; retry.',
      'google_commit',
    );
  }
}
