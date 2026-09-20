import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate, seed } from '../scripts/test-database';
import worker from './index';
import type { HouseholdState, Mutation, Operation } from '../src/data/contracts';

describe('Worker API with real local D1', () => {
  let runtime: ReturnType<typeof createDatabase>, db: D1Database, env: Env;
  beforeEach(async () => {
    runtime = createDatabase();
    db = (await runtime.getD1Database('DB')) as unknown as D1Database;
    await migrate(db);
    env = { DB: db, ASSETS: { fetch: async () => new Response('shell') } as Fetcher };
  });
  afterEach(async () => {
    await runtime.dispose();
  });
  const load = async () =>
    (await (
      await worker.fetch(new Request('https://home.test/api/household'), env)
    ).json()) as HouseholdState;
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request('https://home.test/api/mutations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );
  async function save(operations: Operation[]) {
    const state = await load();
    const response = await send({
      id: crypto.randomUUID(),
      revision: state.household.revision,
      operations,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as HouseholdState;
  }
  const member = { id: 'a', name: 'Alex', initial: 'A', color: '#123456', tint: '#eeeeee' };
  const event = {
    id: 'e',
    sourceId: 'local',
    title: 'Walk',
    date: '2026-09-19',
    allDay: true,
    timeZone: 'America/New_York',
    memberIds: ['a'],
    recurrence: { frequency: 'weekly' as const, until: '2026-12-31' },
  };
  const chore = {
    id: 'c',
    title: 'Dishes',
    dueDate: '2026-09-19',
    memberIds: ['a'],
    recurrence: { frequency: 'daily' as const },
    completedDates: [],
  };

  it('starts empty and keeps the one-time seed deliberate', async () => {
    expect((await load()).family).toEqual([]);
    await seed(db, 'starter');
    let state = await load();
    expect(state.family).toHaveLength(4);
    expect(state.events).toEqual([]);
    expect(state.lists.every((l) => l.items.length === 0)).toBe(true);
    await save([{ type: 'delete', entity: 'member', id: 'jason' }]);
    await seed(db, 'demo');
    state = await load();
    expect(state.family).toHaveLength(3);
    expect(state.events).toEqual([]);
  });
  it('creates, updates and deletes members, recurring events, chores and occurrence completions', async () => {
    await save([
      { type: 'member.put', value: member },
      { type: 'event.put', value: event },
      { type: 'chore.put', value: chore },
    ]);
    let state = await save([
      { type: 'chore.complete', id: 'c', date: '2026-09-19', completed: true },
    ]);
    expect(state.events[0].recurrence.until).toBe('2026-12-31');
    expect(state.events[0].memberIds).toEqual(['a']);
    state = await save([
      { type: 'member.put', value: { ...member, name: 'Alexis' } },
      { type: 'event.put', value: { ...event, title: 'Long walk', memberIds: [] } },
      { type: 'chore.put', value: { ...chore, title: 'Kitchen' } },
    ]);
    expect(state.family[0].name).toBe('Alexis');
    expect(state.events[0].title).toBe('Long walk');
    expect(state.chores[0].completedDates).toEqual(['2026-09-19']);
    state = await save([
      { type: 'chore.complete', id: 'c', date: '2026-09-20', completed: true },
      { type: 'chore.complete', id: 'c', date: '2026-09-19', completed: false },
    ]);
    expect(state.chores[0].completedDates).toEqual(['2026-09-20']);
    state = await save([
      { type: 'delete', entity: 'chore', id: 'c' },
      { type: 'delete', entity: 'event', id: 'e' },
      { type: 'delete', entity: 'member', id: 'a' },
    ]);
    expect(state.chores).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.family).toEqual([]);
    expect((await db.prepare('SELECT * FROM chore_completions').all()).results).toEqual([]);
  });
  it('persists meal, list, item and settings CRUD including check and uncheck', async () => {
    const meal = {
      id: 'm',
      date: '2026-09-19',
      title: 'Tacos',
      emoji: '🌮',
      recipeId: 'future-recipe',
    };
    await save([
      { type: 'meal.put', value: meal },
      { type: 'list.put', value: { id: 'l', name: 'Groceries' } },
      { type: 'item.put', listId: 'l', value: { id: 'i', text: 'Milk', completed: false } },
    ]);
    let state = await save([
      { type: 'meal.put', value: { ...meal, title: 'Soup', notes: 'Prep early' } },
      { type: 'list.put', value: { id: 'l', name: 'Shopping' } },
      { type: 'item.put', listId: 'l', value: { id: 'i', text: 'Oat milk', completed: false } },
      { type: 'item.complete', listId: 'l', id: 'i', completed: true },
      { type: 'settings.put', value: { name: 'Our Family', timeZone: 'Europe/London' } },
    ]);
    expect(state.meals[0].title).toBe('Soup');
    expect(state.lists[0].name).toBe('Shopping');
    expect(state.lists[0].items[0]).toMatchObject({ text: 'Oat milk', completed: true });
    expect(state.household.name).toBe('Our Family');
    state = await save([{ type: 'item.complete', listId: 'l', id: 'i', completed: false }]);
    expect(state.lists[0].items[0].completed).toBe(false);
    state = await save([
      { type: 'delete', entity: 'item', id: 'i' },
      { type: 'delete', entity: 'meal', id: 'm' },
    ]);
    expect(state.lists[0].items).toEqual([]);
    expect(state.meals).toEqual([]);
    await save([
      { type: 'item.put', listId: 'l', value: { id: 'cascade', text: 'Bread', completed: false } },
    ]);
    state = await save([{ type: 'delete', entity: 'list', id: 'l' }]);
    expect(state.lists).toEqual([]);
    expect((await db.prepare('SELECT * FROM list_items').all()).results).toEqual([]);
  });
  it('rejects stale revisions, allows identical retries and rolls back a failed batch', async () => {
    const request: Mutation = {
      id: 'repeat',
      revision: 0,
      operations: [{ type: 'member.put', value: member }],
    };
    expect((await send(request)).status).toBe(200);
    expect((await send(request)).status).toBe(200);
    expect((await load()).household.revision).toBe(1);
    expect(
      (
        await send({
          ...request,
          operations: [{ type: 'member.put', value: { ...member, name: 'Different' } }],
        })
      ).status,
    ).toBe(409);
    expect((await send({ ...request, id: 'stale' })).status).toBe(409);
    await save([{ type: 'event.put', value: event }]);
    const before = await load();
    const response = await send({
      id: 'rollback',
      revision: before.household.revision,
      operations: [
        { type: 'list.put', value: { id: 'l', name: 'Should roll back' } },
        { type: 'delete', entity: 'member', id: 'a' },
      ],
    });
    expect(response.status).toBe(422);
    expect(await load()).toEqual(before);
    expect(
      await db.prepare("SELECT * FROM mutation_receipts WHERE id='rollback'").first(),
    ).toBeNull();
  });
  it('allows only one winner when two devices save the same revision', async () => {
    const results = await Promise.all(
      ['one', 'two'].map((id) =>
        send({ id, revision: 0, operations: [{ type: 'member.put', value: { ...member, id } }] }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await load()).family).toHaveLength(1);
  });
  it('validates input, source identity and origin; never returns cached API HTML', async () => {
    const mutation = (value: unknown) => ({
      id: crypto.randomUUID(),
      revision: 0,
      operations: [value],
    });
    expect(
      (
        await send(mutation({ type: 'member.put', value: member }), {
          Origin: 'https://elsewhere.test',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          mutation({ type: 'event.put', value: { ...event, memberIds: [], date: '2026-02-30' } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          mutation({ type: 'event.put', value: { ...event, memberIds: [], sourceId: 'icloud' } }),
        )
      ).status,
    ).toBe(400);
    expect((await send(mutation({ type: 'event.put', value: event }))).status).toBe(400);
    const response = await worker.fetch(new Request('https://home.test/api/missing'), env);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(
      (await send({ id: 'big', revision: 0, operations: [], padding: 'x'.repeat(66000) })).status,
    ).toBe(413);
  });
  it('binds user text and scopes every read/write to the configured household', async () => {
    await db
      .prepare("INSERT INTO households(id,name,timeZone) VALUES('other','Other','UTC')")
      .run();
    await db
      .prepare("INSERT INTO members VALUES('other','private','Secret','S','#123456','#eeeeee')")
      .run();
    const name = "O'Brien'); DROP TABLE members;--".slice(0, 30);
    await save([{ type: 'member.put', value: { ...member, name } }]);
    expect((await load()).family.map((m) => m.name)).toEqual([name]);
    await save([{ type: 'delete', entity: 'member', id: 'private' }]);
    expect(
      await db.prepare("SELECT name FROM members WHERE household_id='other'").first('name'),
    ).toBe('Secret');
  });
  it('survives a complete local Worker/database runtime restart', async () => {
    await runtime.dispose();
    const directory = mkdtempSync(join(tmpdir(), 'family-dashboard-d1-'));
    try {
      runtime = createDatabase(directory);
      db = (await runtime.getD1Database('DB')) as unknown as D1Database;
      env.DB = db;
      await migrate(db);
      await save([{ type: 'member.put', value: member }]);
      await runtime.dispose();
      runtime = createDatabase(directory);
      env.DB = (await runtime.getD1Database('DB')) as unknown as D1Database;
      expect((await load()).family).toEqual([member]);
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
