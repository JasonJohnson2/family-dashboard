import { createMockData, family } from '../src/data/mock';
import { dateKey } from '../src/lib/dates';

// This module is CLI/test-only. It is never imported by the application Worker.
export function seedStatements(mode: 'starter' | 'demo', today = dateKey(new Date())): string[] {
  const statements: string[] = [];
  const quote = (value: unknown) =>
    value === undefined
      ? 'NULL'
      : typeof value === 'boolean'
        ? String(Number(value))
        : `'${String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
  const guard = "NOT EXISTS (SELECT 1 FROM seed_history WHERE id='initial')";
  function put(table: string, row: Record<string, unknown>) {
    const values = { household_id: 'home', ...row };
    statements.push(
      `INSERT OR IGNORE INTO ${table} (${Object.keys(values).join(',')}) SELECT ${Object.values(values).map(quote).join(',')} WHERE ${guard}`,
    );
  }
  family.forEach((person) => put('members', person));
  const data = createMockData(today);
  for (const list of data.lists) {
    put('lists', { id: list.id, name: list.name });
    if (mode === 'demo')
      list.items.forEach((item) => put('list_items', { ...item, list_id: list.id }));
  }
  if (mode === 'demo') {
    for (const event of data.events) {
      const { memberIds, ...value } = event;
      put('events', {
        ...value,
        sourceId: 'local',
        startTime: value.startTime || undefined,
        endTime: value.endTime || undefined,
      });
      memberIds.forEach((member_id) => put('event_members', { event_id: event.id, member_id }));
    }
    for (const chore of data.chores) {
      const { memberIds, completedDates: _, ...value } = chore;
      put('chores', value);
      memberIds.forEach((member_id) => put('chore_members', { chore_id: chore.id, member_id }));
    }
    data.meals.forEach((meal) => put('meals', meal));
  }
  statements.push(`UPDATE households SET revision=revision+1 WHERE id='home' AND ${guard}`);
  statements.push(`INSERT OR IGNORE INTO seed_history (id,mode) VALUES ('initial',${quote(mode)})`);
  return statements;
}
