import type { CalendarEvent } from '../../src/types';
import { HOUSEHOLD_ID } from '../database';
const eventColumns = [
  'id',
  'sourceId',
  'externalId',
  'title',
  'date',
  'endDate',
  'startTime',
  'endTime',
  'allDay',
  'timeZone',
  'location',
  'notes',
  'recurrence',
  'startInstant',
  'endInstant',
];
function putEvents(db: D1Database, events: CalendarEvent[]) {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < events.length; i += 100) {
    statements.push(
      db
        .prepare(
          `INSERT INTO events (household_id,${eventColumns.join(',')}) SELECT ?,${eventColumns.map((c) => `json_extract(value,'$.${c}')`).join(',')} FROM json_each(?) WHERE true ON CONFLICT(household_id,id) DO UPDATE SET ${eventColumns
            .filter((c) => c !== 'id')
            .map((c) => `${c}=excluded.${c}`)
            .join(
              ',',
            )} WHERE events.sourceId=excluded.sourceId AND events.externalId=excluded.externalId`,
        )
        .bind(HOUSEHOLD_ID, JSON.stringify(events.slice(i, i + 100))),
    );
  }
  return statements;
}
// Read under the operation lease, then commit this delta and metadata together with fencing.
// Local events are protected even when an imported provider ID collides with their IDs.
export async function projectionChanges(
  db: D1Database,
  calendar: { source_id: string; member_id: string | null },
  imported: CalendarEvent[],
  removed: string[],
  full: boolean,
) {
  const incoming = new Map(imported.map((event) => [event.id, event]));
  const rows = (
    await db
      .prepare(
        'SELECT * FROM events WHERE household_id=? AND (sourceId=? OR id IN (SELECT value FROM json_each(?)))',
      )
      .bind(HOUSEHOLD_ID, calendar.source_id, JSON.stringify([...incoming.keys()]))
      .all<Record<string, unknown>>()
  ).results;
  const existing = new Map(rows.map((row) => [String(row.id), row]));
  const excluded = new Set(removed);
  const deleted = rows
    .filter(
      (row) =>
        row.sourceId === calendar.source_id &&
        (excluded.has(String(row.id)) || (full && !incoming.has(String(row.id)))),
    )
    .map((row) => String(row.id));
  const deletedIds = new Set(deleted);
  const changed = [...incoming.values()].filter((event) => {
    if (excluded.has(event.id)) return false;
    const prior = existing.get(event.id);
    if (!prior) return true;
    if (prior.sourceId !== calendar.source_id || prior.externalId !== event.externalId)
      return false;
    return eventColumns.some((column) => {
      const value =
        column === 'allDay'
          ? Number(event.allDay)
          : column === 'recurrence'
            ? JSON.stringify(event.recurrence)
            : (event[column as keyof CalendarEvent] ?? null);
      return prior[column] !== value;
    });
  });
  const kept = new Set(
    rows
      .filter((row) => row.sourceId === calendar.source_id && !deletedIds.has(String(row.id)))
      .map((row) => String(row.id)),
  );
  changed.forEach((event) => kept.add(event.id));
  const assignments = (
    await db
      .prepare(
        'SELECT m.event_id,m.member_id FROM event_members m JOIN events e ON e.household_id=m.household_id AND e.id=m.event_id WHERE e.household_id=? AND e.sourceId=?',
      )
      .bind(HOUSEHOLD_ID, calendar.source_id)
      .all<{ event_id: string; member_id: string }>()
  ).results;
  const correct = new Set(
    assignments.filter((m) => m.member_id === calendar.member_id).map((m) => m.event_id),
  );
  const membersChanged =
    assignments.some((m) => kept.has(m.event_id) && m.member_id !== calendar.member_id) ||
    (!!calendar.member_id && [...kept].some((id) => !correct.has(id)));
  const statements = putEvents(db, changed);
  if (deleted.length)
    statements.push(
      db
        .prepare(
          'DELETE FROM events WHERE household_id=? AND sourceId=? AND id IN (SELECT value FROM json_each(?))',
        )
        .bind(HOUSEHOLD_ID, calendar.source_id, JSON.stringify(deleted)),
    );
  if (membersChanged)
    statements.push(...assignImportedEvents(db, calendar.source_id, calendar.member_id));
  return { statements, visibleChanged: !!(changed.length || deleted.length || membersChanged) };
}

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
