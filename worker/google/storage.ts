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
export { assignImportedEvents } from '../calendar/projection';
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
export { withLease, commit } from '../calendar/lease';
