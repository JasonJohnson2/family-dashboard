import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createDatabase, migrate, applyMigration } from '../../scripts/test-database';
import { authenticatedWorker as worker, testSession } from '../../scripts/test-auth';
import realWorker from '../index';
import { readState } from '../database';
import { occurrence } from '../../src/lib/localCalendar';
import type { CalendarEvent, EventOccurrence } from '../../src/types';
import type { HouseholdState, Operation } from '../../src/data/contracts';
vi.setConfig({ testTimeout: 60_000 }); // Real D1 end-to-end scenarios contain several serialized saves.
const soccer: CalendarEvent = {
  id: 'soccer-v2',
  sourceId: 'local',
  title: 'Soccer Practice',
  date: '2026-10-06',
  startTime: '17:30',
  endTime: '19:00',
  allDay: false,
  timeZone: 'America/New_York',
  memberIds: ['sam', 'millie'],
  location: 'Soccer Fields',
  notes: 'Bring cleats',
  recurrence: { frequency: 'weekly', byWeekday: [2, 4] },
};
describe('local calendar with real D1', () => {
  let runtime: ReturnType<typeof createDatabase>, db: D1Database, env: Env;
  beforeEach(async () => {
    runtime = createDatabase();
    db = (await runtime.getD1Database('DB')) as unknown as D1Database;
    await migrate(db);
    await testSession(db);
    env = {
      DB: db,
      ASSETS: { fetch: async () => new Response('shell') },
      AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as Env;
  });
  afterEach(async () => {
    await runtime.dispose();
  });
  const send = async (operations: unknown[], revision?: number, id = crypto.randomUUID()) =>
    worker.fetch(
      new Request('https://home.test/api/mutations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          revision: revision ?? (await readState(db)).household.revision,
          operations,
        }),
      }),
      env,
    );
  async function save(ops: Operation[]) {
    const r = await send(ops);
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as HouseholdState;
  }
  async function setup() {
    await save(
      ['sam', 'millie'].map((id) => ({
        type: 'member.put',
        value: {
          id,
          name: id,
          initial: id[0],
          role: id === 'sam' ? 'adult' : 'child',
          color: '#2877c5',
          tint: '#dceeff',
        },
      })),
    );
    return save([{ type: 'event.put', value: soccer }]);
  }
  const window = async (from: string, to = from) => {
    const r = await worker.fetch(
      new Request('https://home.test/api/calendar/events?from=' + from + '&to=' + to),
      env,
    );
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as EventOccurrence[];
  };
  it('passes the complete requested soccer scenario, persists compact rows and never writes on read', async () => {
    await setup();
    expect((await window('2026-10-06', '2026-10-15')).map((e) => e.date)).toEqual([
      '2026-10-06',
      '2026-10-08',
      '2026-10-13',
      '2026-10-15',
    ]);
    let state = await save([
      {
        type: 'event.edit',
        id: soccer.id,
        recurrenceDate: '2026-10-06',
        scope: 'this',
        value: {
          ...soccer,
          date: '2026-10-07',
          startTime: '18:00',
          endTime: '19:30',
          recurrence: { frequency: 'none' },
        },
      },
    ]);
    expect(await window('2026-10-06')).toHaveLength(0);
    expect((await window('2026-10-07'))[0]).toMatchObject({
      title: 'Soccer Practice',
      startTime: '18:00',
      endTime: '19:30',
      memberIds: ['sam', 'millie'],
      recurrenceDate: '2026-10-06',
    });
    expect((await window('2026-10-08'))[0].startTime).toBe('17:30');
    state = await save([
      {
        type: 'event.edit',
        id: soccer.id,
        recurrenceDate: '2026-10-15',
        scope: 'future',
        newSeriesId: 'future',
        value: {
          ...occurrence(state.events[0], '2026-10-15'),
          startTime: '18:00',
          endTime: '19:30',
        },
      },
    ]);
    expect(state.events).toHaveLength(2);
    expect((await window('2026-10-13'))[0].startTime).toBe('17:30');
    expect((await window('2026-10-15'))[0].startTime).toBe('18:00');
    state = await save([
      { type: 'event.delete', id: 'future', recurrenceDate: '2026-10-20', scope: 'this' },
    ]);
    expect(await window('2026-10-20')).toHaveLength(0);
    expect(await window('2026-10-22')).toHaveLength(1);
    state = await save([
      { type: 'event.delete', id: 'future', recurrenceDate: '2026-10-22', scope: 'future' },
    ]);
    expect(await window('2026-10-22')).toHaveLength(0);
    expect((await window('2026-10-07'))[0].isException).toBe(true);
    await db.prepare('CREATE TABLE calendar_write_audit (value INTEGER)').run();
    for (const table of ['events', 'event_members', 'event_exceptions', 'local_event_metadata'])
      for (const action of ['INSERT', 'UPDATE', 'DELETE'])
        await db
          .prepare(
            'CREATE TRIGGER audit_' +
              table +
              '_' +
              action +
              ' AFTER ' +
              action +
              ' ON ' +
              table +
              ' BEGIN INSERT INTO calendar_write_audit VALUES (1); END',
          )
          .run();
    await window('2026-10-01', '2026-10-31');
    await readState(db);
    await window('2199-12-01', '2199-12-31');
    expect(
      (await db.prepare('SELECT COUNT(*) n FROM calendar_write_audit').first<{ n: number }>())!.n,
    ).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) n FROM events').first<{ n: number }>())!.n).toBe(2);
    expect(
      (await db.prepare('SELECT COUNT(*) n FROM event_exceptions').first<{ n: number }>())!.n,
    ).toBe(2);
  });
  it('creates everyone, single/multiple assignments, all-day and timed multiday events with server timestamps and reminder config', async () => {
    await setup();
    let state = await save([
      {
        type: 'event.put',
        value: {
          ...soccer,
          id: 'vacation',
          date: '2026-03-07',
          endDate: '2026-03-09',
          allDay: true,
          startTime: undefined,
          endTime: undefined,
          memberIds: [],
          recurrence: { frequency: 'none' },
          reminderMinutes: 1440,
        },
      },
      {
        type: 'event.put',
        value: {
          ...soccer,
          id: 'camping',
          date: '2026-10-09',
          endDate: '2026-10-11',
          startTime: '17:00',
          endTime: '11:00',
          memberIds: ['millie'],
          recurrence: { frequency: 'none' },
        },
      },
    ]);
    expect((await window('2026-03-07', '2026-03-09')).map((e) => e.occurrenceDate)).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
    expect((await window('2026-10-10'))[0]).toMatchObject({
      id: 'camping',
      date: '2026-10-09',
      endDate: '2026-10-11',
      memberIds: ['millie'],
    });
    expect(state.events.find((e) => e.id === 'vacation')).toMatchObject({
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      reminderMinutes: 1440,
      location: 'Soccer Fields',
      notes: 'Bring cleats',
    });
    const before = state.events.find((e) => e.id === 'vacation')!;
    state = await save([
      { type: 'event.put', value: { ...before, title: 'Trip', createdAt: 'forged' } },
    ]);
    expect(state.events.find((e) => e.id === 'vacation')!.createdAt).toBe(before.createdAt);
  });
  it('updates and cancels a moved exception, preserves exceptions through details-only whole-series changes and resets them after a schedule change', async () => {
    await setup();
    let state = await save([
      {
        type: 'event.edit',
        id: soccer.id,
        recurrenceDate: '2026-10-06',
        scope: 'this',
        value: { ...soccer, date: '2026-10-07', memberIds: ['millie'] },
      },
    ]);
    state = await save([
      {
        type: 'event.edit',
        id: soccer.id,
        recurrenceDate: '2026-10-06',
        scope: 'this',
        value: { ...soccer, date: '2026-10-09', notes: 'Moved again' },
      },
    ]);
    expect(state.eventExceptions).toHaveLength(1);
    expect(await window('2026-10-07')).toHaveLength(0);
    state = await save([
      {
        type: 'event.edit',
        id: soccer.id,
        recurrenceDate: '2026-10-08',
        scope: 'all',
        value: { ...state.events[0], title: 'New series title' },
      },
    ]);
    expect(state.eventExceptions).toHaveLength(1);
    state = await save([
      {
        type: 'event.edit',
        id: soccer.id,
        recurrenceDate: '2026-10-08',
        scope: 'all',
        value: { ...state.events[0], startTime: '18:00' },
      },
    ]);
    expect(state.eventExceptions).toHaveLength(0);
    expect((await window('2026-10-06'))[0].startTime).toBe('18:00');
    state = await save([
      { type: 'event.delete', id: soccer.id, recurrenceDate: '2026-10-08', scope: 'all' },
    ]);
    expect(state.events).toHaveLength(0);
    expect(state.eventExceptions).toHaveLength(0);
  });
  it('rejects invalid members, invented occurrences, invalid recurrence, DST gaps and conflicting saves; retries remain idempotent', async () => {
    const state = await setup();
    for (const op of [
      { type: 'event.put', value: { ...soccer, memberIds: ['other-household'] } },
      {
        type: 'event.edit',
        id: soccer.id,
        recurrenceDate: '2026-10-07',
        scope: 'this',
        value: soccer,
      },
      {
        type: 'event.put',
        value: { ...soccer, recurrence: { frequency: 'weekly', byWeekday: [] } },
      },
      {
        type: 'event.put',
        value: {
          ...soccer,
          date: '2026-03-08',
          startTime: '02:30',
          recurrence: { frequency: 'none' },
        },
      },
      {
        type: 'event.edit',
        id: soccer.id,
        recurrenceDate: soccer.date,
        scope: 'future',
        newSeriesId: soccer.id,
        value: soccer,
      },
    ])
      expect((await send([op])).status).toBe(400);
    expect(
      (
        await send([
          { type: 'event.delete', id: 'foreign-event', recurrenceDate: soccer.date, scope: 'all' },
        ])
      ).status,
    ).toBe(404);
    const id = crypto.randomUUID(),
      ops = [
        {
          type: 'event.edit',
          id: soccer.id,
          recurrenceDate: soccer.date,
          scope: 'future',
          newSeriesId: 'new',
          value: { ...soccer, title: 'New' },
        },
      ];
    expect((await send(ops, state.household.revision, id)).status).toBe(200);
    expect((await send(ops, state.household.revision, id)).status).toBe(200);
    expect((await readState(db)).events).toHaveLength(1);
    expect(
      (await send([{ type: 'event.put', value: soccer }], state.household.revision)).status,
    ).toBe(409);
    expect(
      (
        await worker.fetch(
          new Request('https://home.test/api/calendar/events?from=2026-01-01&to=2027-01-01'),
          env,
        )
      ).status,
    ).toBe(400);
  });
  it('enforces authenticated household ownership and imported Google/iCloud boundaries for every local command', async () => {
    await setup();
    expect(
      (
        await realWorker.fetch(
          new Request('https://home.test/api/calendar/events?from=2026-10-06&to=2026-10-06'),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await realWorker.fetch(
          new Request('https://home.test/api/mutations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }),
          env,
        )
      ).status,
    ).toBe(401);
    for (const provider of ['google', 'icloud']) {
      const source = provider + '-source',
        id = (provider === 'google' ? 'g_' : 'i_') + 'external';
      await db
        .prepare('INSERT INTO calendar_sources VALUES (?,?,?,?,?)')
        .bind('home', source, provider, provider, '#123456')
        .run();
      await db
        .prepare(
          'INSERT INTO events (household_id,id,sourceId,title,date,allDay,timeZone,recurrence) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(
          'home',
          id,
          source,
          'Imported',
          '2026-10-06',
          1,
          'America/New_York',
          '{"frequency":"none"}',
        )
        .run();
      for (const op of [
        { type: 'event.put', value: { ...soccer, id } },
        {
          type: 'event.edit',
          id,
          recurrenceDate: soccer.date,
          scope: 'this',
          value: { ...soccer, id },
        },
        { type: 'event.delete', id, recurrenceDate: soccer.date, scope: 'all' },
        { type: 'delete', entity: 'event', id },
      ])
        expect((await send([op])).status).toBe(400);
      expect((await window('2026-10-06')).some((e) => e.id === id)).toBe(true);
    }
  });
});
it('migrates existing local and imported rows without changing IDs, times, recurrence or assignments', async () => {
  const runtime = createDatabase();
  try {
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database;
    await migrate(db, '0009_google_reconnect.sql');
    await db
      .prepare(
        'INSERT INTO events (household_id,id,sourceId,title,date,startTime,endTime,allDay,timeZone,recurrence) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        'home',
        'legacy',
        'local',
        'Existing',
        '2026-10-06',
        '17:30',
        '19:00',
        0,
        'America/New_York',
        '{"frequency":"weekly","until":"2026-12-31"}',
      )
      .run();
    await db.batch([
      db.prepare(
        "INSERT INTO members (household_id,id,name,initial,color,tint,role) VALUES ('home','legacy-person','Existing person','E','#123456','#eeeeee','child')",
      ),
      db.prepare("INSERT INTO event_members VALUES ('home','legacy','legacy-person')"),
      db.prepare(
        "INSERT INTO calendar_sources VALUES ('home','google-legacy','Google','google','#123456')",
      ),
      db
        .prepare(
          'INSERT INTO events (household_id,id,sourceId,title,date,allDay,timeZone,recurrence) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(
          'home',
          'g_legacy',
          'google-legacy',
          'Imported',
          '2026-10-06',
          1,
          'America/New_York',
          JSON.stringify({ frequency: 'none' }),
        ),
    ]);
    const eventRowsBefore = (await db.prepare('SELECT * FROM events ORDER BY id').all()).results;
    const columnsBefore = (await db.prepare('PRAGMA table_info(events)').all()).results;
    await applyMigration(db, '0010_local_calendar_v2.sql');
    expect((await db.prepare('SELECT * FROM events ORDER BY id').all()).results).toEqual(
      eventRowsBefore,
    );
    expect((await db.prepare('PRAGMA table_info(events)').all()).results).toEqual(columnsBefore);
    const state = await readState(db);
    expect(state.events[0]).toMatchObject({
      id: 'legacy',
      title: 'Existing',
      date: '2026-10-06',
      startTime: '17:30',
      endTime: '19:00',
      recurrence: { frequency: 'weekly', until: '2026-12-31' },
      memberIds: ['legacy-person'],
      createdAt: expect.any(String),
    });
    expect(state.eventExceptions).toEqual([]);
  } finally {
    await runtime.dispose();
  }
});
