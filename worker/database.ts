import {
  stateSchema,
  type HouseholdState,
  type Mutation,
  type Operation,
} from '../src/data/contracts';
import { occursOn } from '../src/lib/dates';
export const HOUSEHOLD_ID = 'home';
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'invalid_request',
  ) {
    super(message);
  }
}
type Row = Record<string, unknown>;
const tables = [
  'households',
  'members',
  'calendar_sources',
  'events',
  'event_members',
  'chores',
  'chore_members',
  'chore_completions',
  'meals',
  'lists',
  'list_items',
] as const;

export async function readState(db: D1Database): Promise<HouseholdState> {
  const results = await db.batch<Row>(
    tables.map((table) =>
      db
        .prepare(
          `SELECT * FROM ${table} WHERE ${table === 'households' ? 'id' : 'household_id'} = ? ORDER BY rowid`,
        )
        .bind(HOUSEHOLD_ID),
    ),
  );
  const [
    households,
    members,
    sources,
    events,
    eventMembers,
    chores,
    choreMembers,
    completions,
    meals,
    lists,
    items,
  ] = results.map((r) => r.results);
  if (!households[0])
    throw new ApiError(
      503,
      'The household database is not initialized. Apply the database migrations.',
      'not_initialized',
    );
  const clean = (row: Row) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([key, value]) =>
          value !== null &&
          !['household_id', 'created_at', 'completed_at', 'list_id'].includes(key),
      ),
    );
  const assignments = (rows: Row[], column: string, id: unknown) =>
    rows.filter((row) => row[column] === id).map((row) => row.member_id);
  return stateSchema.parse({
    household: clean(households[0]),
    family: members.map(clean),
    sources: sources.map(clean),
    events: events.map((row) => ({
      ...clean(row),
      allDay: !!row.allDay,
      recurrence: JSON.parse(String(row.recurrence)),
      memberIds: assignments(eventMembers, 'event_id', row.id),
    })),
    chores: chores.map((row) => ({
      ...clean(row),
      recurrence: JSON.parse(String(row.recurrence)),
      memberIds: assignments(choreMembers, 'chore_id', row.id),
      completedDates: completions.filter((c) => c.chore_id === row.id).map((c) => c.date),
    })),
    meals: meals.map(clean),
    lists: lists.map((row) => ({
      ...clean(row),
      items: items
        .filter((i) => i.list_id === row.id)
        .map((item) => ({ ...clean(item), completed: !!item.completed })),
    })),
  });
}

const fields = {
  members: ['id', 'name', 'initial', 'color', 'tint'],
  events: [
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
  ],
  chores: ['id', 'title', 'dueDate', 'recurrence'],
  meals: ['id', 'date', 'title', 'emoji', 'recipeId', 'notes'],
  lists: ['id', 'name'],
  list_items: ['id', 'list_id', 'text', 'completed', 'recipeId'],
} as const;
const entityTable = {
  member: 'members',
  event: 'events',
  chore: 'chores',
  meal: 'meals',
  list: 'lists',
  item: 'list_items',
} as const;

// Every write is gated by this request's receipt AND the revision still being its predecessor.
// The receipt, model changes, and revision increment run in one atomic D1 batch.
export function mutationStatements(
  db: D1Database,
  mutation: Mutation,
  fingerprint: string,
): D1PreparedStatement[] {
  const params = [HOUSEHOLD_ID, mutation.id, mutation.revision + 1, mutation.revision];
  const gate = `EXISTS (SELECT 1 FROM mutation_receipts r JOIN households h ON h.id=r.household_id WHERE r.household_id=? AND r.id=? AND r.revision=? AND h.revision=?)`;
  const statements: D1PreparedStatement[] = [];
  const write = (sql: string, values: unknown[]) =>
    statements.push(db.prepare(sql).bind(...values, ...params));
  function put(table: keyof typeof fields, value: object) {
    const record = value as Row;
    const columns = fields[table];
    const values = columns.map((key) => {
      const v = record[key];
      return v === undefined
        ? null
        : typeof v === 'boolean'
          ? Number(v)
          : typeof v === 'object'
            ? JSON.stringify(v)
            : v;
    });
    write(
      `INSERT INTO ${table} (household_id,${columns.join(',')}) SELECT ?,${columns.map(() => '?').join(',')} WHERE ${gate} ON CONFLICT(household_id,id) DO UPDATE SET ${columns
        .filter((c) => c !== 'id')
        .map((c) => `${c}=excluded.${c}`)
        .join(',')}`,
      [HOUSEHOLD_ID, ...values],
    );
  }
  function assign(
    table: 'event_members' | 'chore_members',
    column: 'event_id' | 'chore_id',
    id: string,
    ids: string[],
  ) {
    write(`DELETE FROM ${table} WHERE household_id=? AND ${column}=? AND ${gate}`, [
      HOUSEHOLD_ID,
      id,
    ]);
    write(
      `INSERT INTO ${table} (household_id,${column},member_id) SELECT ?,?,value FROM json_each(?) WHERE ${gate}`,
      [HOUSEHOLD_ID, id, JSON.stringify(ids)],
    );
  }
  for (const op of mutation.operations) {
    switch (op.type) {
      case 'member.put':
        put('members', op.value);
        break;
      case 'event.put':
        put('events', op.value);
        assign('event_members', 'event_id', op.value.id, op.value.memberIds);
        break;
      case 'chore.put':
        put('chores', op.value);
        assign('chore_members', 'chore_id', op.value.id, op.value.memberIds);
        break;
      case 'meal.put':
        put('meals', op.value);
        break;
      case 'list.put':
        put('lists', op.value);
        break;
      case 'item.put':
        put('list_items', { ...op.value, list_id: op.listId });
        break;
      case 'item.complete':
        write(
          `UPDATE list_items SET completed=? WHERE household_id=? AND list_id=? AND id=? AND ${gate}`,
          [Number(op.completed), HOUSEHOLD_ID, op.listId, op.id],
        );
        break;
      case 'chore.complete':
        if (op.completed)
          write(
            `INSERT OR IGNORE INTO chore_completions (household_id,chore_id,date) SELECT ?,?,? WHERE ${gate}`,
            [HOUSEHOLD_ID, op.id, op.date],
          );
        else
          write(
            `DELETE FROM chore_completions WHERE household_id=? AND chore_id=? AND date=? AND ${gate}`,
            [HOUSEHOLD_ID, op.id, op.date],
          );
        break;
      case 'settings.put':
        write(`UPDATE households SET name=?,timeZone=? WHERE id=? AND ${gate}`, [
          op.value.name,
          op.value.timeZone,
          HOUSEHOLD_ID,
        ]);
        break;
      case 'delete':
        write(`DELETE FROM ${entityTable[op.entity]} WHERE household_id=? AND id=? AND ${gate}`, [
          HOUSEHOLD_ID,
          op.id,
        ]);
        break;
    }
  }
  if (statements.length > 24) throw new ApiError(400, 'Save fewer records at a time.');
  return [
    db
      .prepare(
        'INSERT OR IGNORE INTO mutation_receipts (household_id,id,fingerprint,revision) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM households WHERE id=? AND revision=?)',
      )
      .bind(
        HOUSEHOLD_ID,
        mutation.id,
        fingerprint,
        mutation.revision + 1,
        HOUSEHOLD_ID,
        mutation.revision,
      ),
    ...statements,
    db
      .prepare(`UPDATE households SET revision=revision+1 WHERE id=? AND ${gate}`)
      .bind(HOUSEHOLD_ID, ...params),
  ];
}

export function validateReferences(state: HouseholdState, operations: Operation[]) {
  // Validate against a draft so a batch can create a list and then an item in that list.
  const members = new Set(state.family.map((m) => m.id)),
    lists = new Set(state.lists.map((l) => l.id));
  for (const op of operations) {
    if (op.type === 'member.put') members.add(op.value.id);
    if (op.type === 'list.put') lists.add(op.value.id);
    if (op.type === 'event.put' || op.type === 'chore.put') {
      if (op.value.memberIds.some((id) => !members.has(id)))
        throw new ApiError(400, 'An assigned family member no longer exists.');
    }
    if (op.type === 'event.put' && op.value.sourceId !== 'local')
      throw new ApiError(400, 'Dashboard events must use the local calendar.');
    if (op.type === 'item.put' && !lists.has(op.listId))
      throw new ApiError(404, 'This list no longer exists.');
    if (
      op.type === 'item.complete' &&
      !state.lists.find((l) => l.id === op.listId)?.items.some((i) => i.id === op.id)
    )
      throw new ApiError(404, 'This list item no longer exists.');
    if (op.type === 'chore.complete') {
      const chore = state.chores.find((c) => c.id === op.id);
      if (!chore) throw new ApiError(404, 'This chore no longer exists.');
      if (!occursOn(chore.dueDate, op.date, chore.recurrence))
        throw new ApiError(400, 'The chore is not due on that date.');
    }
  }
}
