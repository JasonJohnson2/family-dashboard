import { describe, it, expect } from 'vitest';
import {
  eventDays,
  eventWindow,
  recurrenceIndex,
  applyLocalEventChange,
  occurrence,
} from './localCalendar';
import { eventTimeLabel } from './dates';
import { wallInstant } from './eventTime';
import { eventSchema } from '../data/contracts';
import type { CalendarEvent, EventRecurrenceRule } from '../types';
const base: CalendarEvent = {
  id: 'soccer',
  sourceId: 'local',
  title: 'Soccer',
  date: '2026-10-06',
  startTime: '17:30',
  endTime: '19:00',
  allDay: false,
  timeZone: 'America/New_York',
  memberIds: ['sam', 'millie'],
  location: 'Soccer Fields',
  recurrence: { frequency: 'weekly', byWeekday: [2, 4] },
};
const dates = (event: CalendarEvent, from: string, to: string) =>
  eventWindow([event], [], from, to).map((e) => e.date);
describe('bounded local recurrence', () => {
  it.each<[EventRecurrenceRule, string, string, string[]]>([
    [{ frequency: 'none' }, '2026-10-06', '2026-10-09', ['2026-10-06']],
    [
      { frequency: 'daily' },
      '2026-10-06',
      '2026-10-09',
      ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
    ],
    [{ frequency: 'weekdays' }, '2026-10-09', '2026-10-12', ['2026-10-09', '2026-10-12']],
    [{ frequency: 'weekly' }, '2026-10-06', '2026-10-15', ['2026-10-06', '2026-10-13']],
    [
      { frequency: 'weekly', byWeekday: [2, 4] },
      '2026-10-06',
      '2026-10-15',
      ['2026-10-06', '2026-10-08', '2026-10-13', '2026-10-15'],
    ],
    [
      { frequency: 'weekly', interval: 2, byWeekday: [2, 4] },
      '2026-10-06',
      '2026-10-22',
      ['2026-10-06', '2026-10-08', '2026-10-20', '2026-10-22'],
    ],
    [
      { frequency: 'daily', interval: 3 },
      '2026-10-06',
      '2026-10-12',
      ['2026-10-06', '2026-10-09', '2026-10-12'],
    ],
    [{ frequency: 'monthly', interval: 6 }, '2027-04-01', '2027-04-30', ['2027-04-06']],
    [{ frequency: 'yearly' }, '2027-10-01', '2027-10-31', ['2027-10-06']],
    [
      { frequency: 'weekly', byWeekday: [2, 4], until: '2026-10-13' },
      '2026-10-06',
      '2026-10-22',
      ['2026-10-06', '2026-10-08', '2026-10-13'],
    ],
    [
      { frequency: 'weekly', byWeekday: [2, 4], count: 3 },
      '2026-10-06',
      '2026-10-22',
      ['2026-10-06', '2026-10-08', '2026-10-13'],
    ],
  ])('expands %j in the requested window', (r, from, to, expected) =>
    expect(dates({ ...base, recurrence: r }, from, to)).toEqual(expected),
  );
  it('skips invalid month-end and leap-year dates rather than drifting', () => {
    const e = {
      ...base,
      date: '2026-01-31',
      recurrence: { frequency: 'monthly', count: 3 } as EventRecurrenceRule,
    };
    expect(dates(e, '2026-02-01', '2026-03-31')).toEqual(['2026-03-31']);
    expect(recurrenceIndex(e, '2026-05-31')).toBe(2);
    expect(recurrenceIndex(e, '2026-07-31')).toBeUndefined();
    expect(
      dates(
        { ...base, date: '2024-02-29', recurrence: { frequency: 'yearly', count: 2 } },
        '2028-02-01',
        '2028-03-01',
      ),
    ).toEqual(['2028-02-29']);
  });
  it('supports first and last Sunday of a month, fifth weekdays and count', () => {
    const e = {
      ...base,
      date: '2026-10-04',
      recurrence: {
        frequency: 'monthly',
        byWeekday: [0],
        monthWeek: 1,
        count: 3,
      } as EventRecurrenceRule,
    };
    expect(dates(e, '2026-11-01', '2026-12-31')).toEqual(['2026-11-01', '2026-12-06']);
    expect(
      dates(
        { ...e, recurrence: { frequency: 'monthly', monthWeek: -1, byWeekday: [0] } },
        '2026-10-01',
        '2026-11-30',
      ),
    ).toEqual(['2026-10-25', '2026-11-29']);
    expect(
      dates(
        { ...e, recurrence: { frequency: 'monthly', monthWeek: 5, byWeekday: [0] } },
        '2026-10-01',
        '2026-11-30',
      ),
    ).toEqual(['2026-11-29']);
  });
  it('seeks directly to distant daily/weekly windows and bounds expansion', () => {
    expect(
      dates(
        { ...base, date: '1900-01-01', recurrence: { frequency: 'daily' } },
        '2199-12-01',
        '2199-12-31',
      ),
    ).toHaveLength(31);
    expect(() => eventWindow([base], [], '2026-01-01', '2027-01-01')).toThrow('62 days');
  });
  it('renders inclusive all-day spans and excludes timed midnight end days', () => {
    const e = {
      ...base,
      date: '2026-10-10',
      endDate: '2026-10-15',
      allDay: true,
      recurrence: { frequency: 'none' } as const,
    };
    expect(dates(e, '2026-10-09', '2026-10-16')).toHaveLength(6);
    expect(
      eventDays([{ ...e, allDay: false, startTime: '17:00', endTime: '00:00' }], [], '2026-10-15'),
    ).toHaveLength(0);
    const overlapping = {
      ...base,
      endDate: '2026-10-08',
      recurrence: { frequency: 'daily' },
    } as CalendarEvent;
    expect(eventDays([overlapping], [], '2026-10-08')).toHaveLength(3);
    expect(
      new Set(eventDays([overlapping], [], '2026-10-08').map((e) => e.occurrenceId)).size,
    ).toBe(3);
  });
});
describe('scoped transitions', () => {
  it('moves, re-edits, changes member assignment and cancels one occurrence without duplicates', () => {
    let state = applyLocalEventChange([base], [], {
      type: 'event.edit',
      id: base.id,
      recurrenceDate: '2026-10-06',
      scope: 'this',
      value: {
        ...base,
        date: '2026-10-07',
        startTime: '18:00',
        endTime: '19:30',
        memberIds: ['millie'],
      },
    });
    expect(eventDays(state.events, state.eventExceptions, '2026-10-06')).toHaveLength(0);
    expect(eventDays(state.events, state.eventExceptions, '2026-10-07')[0]).toMatchObject({
      startTime: '18:00',
      recurrenceDate: '2026-10-06',
      memberIds: ['millie'],
    });
    expect(eventDays(state.events, state.eventExceptions, '2026-10-08')[0].startTime).toBe('17:30');
    state = applyLocalEventChange(state.events, state.eventExceptions, {
      type: 'event.edit',
      id: base.id,
      recurrenceDate: '2026-10-06',
      scope: 'this',
      value: { ...base, date: '2026-10-09', title: 'Moved again' },
    });
    expect(state.eventExceptions).toHaveLength(1);
    expect(eventDays(state.events, state.eventExceptions, '2026-10-07')).toHaveLength(0);
    state = applyLocalEventChange(state.events, state.eventExceptions, {
      type: 'event.delete',
      id: base.id,
      recurrenceDate: '2026-10-06',
      scope: 'this',
    });
    expect(state.eventExceptions[0].cancelled).toBe(true);
    expect(eventDays(state.events, state.eventExceptions, '2026-10-09')).toHaveLength(0);
  });
  it('splits a counted series, keeps history and transfers exceptions only for an unchanged schedule', () => {
    const e = { ...base, recurrence: { ...base.recurrence, count: 8 }, externalId: 'legacy' };
    const exception = { eventId: e.id, recurrenceDate: '2026-10-20', cancelled: true };
    const split = applyLocalEventChange([e], [exception], {
      type: 'event.edit',
      id: e.id,
      recurrenceDate: '2026-10-15',
      scope: 'future',
      newSeriesId: 'new',
      value: { ...occurrence(e, '2026-10-15'), title: 'New name' },
    });
    expect(split.events).toHaveLength(2);
    expect(split.events.find((v) => v.id === 'new')).toMatchObject({
      recurrence: { count: 5 },
      externalId: undefined,
    });
    expect(split.eventExceptions[0].eventId).toBe('new');
    expect(
      eventWindow(split.events, split.eventExceptions, '2026-10-06', '2026-10-31'),
    ).toHaveLength(7);
    const changed = applyLocalEventChange([e], [exception], {
      type: 'event.edit',
      id: e.id,
      recurrenceDate: '2026-10-15',
      scope: 'future',
      newSeriesId: 'new',
      value: { ...occurrence(e, '2026-10-15'), startTime: '18:00' },
    });
    expect(changed.eventExceptions).toHaveLength(0);
  });
  it('preserves earlier exceptions on split/delete, clears scoped overrides on schedule changes, keeps detail-only overrides', () => {
    const ex = [
      { eventId: base.id, recurrenceDate: '2026-10-06', cancelled: true },
      { eventId: base.id, recurrenceDate: '2026-10-20', cancelled: true },
    ];
    const future = applyLocalEventChange([base], ex, {
      type: 'event.delete',
      id: base.id,
      recurrenceDate: '2026-10-15',
      scope: 'future',
    });
    expect(future.eventExceptions).toHaveLength(1);
    expect(eventDays(future.events, future.eventExceptions, '2026-10-13')).toHaveLength(1);
    expect(eventDays(future.events, future.eventExceptions, '2026-10-15')).toHaveLength(0);
    expect(
      applyLocalEventChange([base], ex, {
        type: 'event.edit',
        id: base.id,
        recurrenceDate: base.date,
        scope: 'all',
        value: { ...base, title: 'New title' },
      }).eventExceptions,
    ).toHaveLength(2);
    expect(
      applyLocalEventChange([base], ex, {
        type: 'event.edit',
        id: base.id,
        recurrenceDate: base.date,
        scope: 'all',
        value: { ...base, recurrence: { frequency: 'daily' } },
      }).eventExceptions,
    ).toHaveLength(0);
    expect(
      applyLocalEventChange([base], ex, {
        type: 'event.delete',
        id: base.id,
        recurrenceDate: base.date,
        scope: 'all',
      }),
    ).toEqual({ events: [], eventExceptions: [] });
  });
});
describe('civil dates and DST', () => {
  it.each([
    ['2026-03-07', '2026-03-08', '2026-03-07T22:30:00.000Z', '2026-03-08T21:30:00.000Z'],
    ['2026-10-31', '2026-11-01', '2026-10-31T21:30:00.000Z', '2026-11-01T22:30:00.000Z'],
  ])('keeps 5:30 PM stable across %s', (before, after, a, b) => {
    const e = { ...base, date: before, recurrence: { frequency: 'daily' } } as CalendarEvent;
    expect(dates(e, before, after)).toEqual([before, after]);
    expect(eventDays([e], [], after)[0].startTime).toBe('17:30');
    expect(wallInstant(before, '17:30', e.timeZone)).toBe(a);
    expect(wallInstant(after, '17:30', e.timeZone)).toBe(b);
  });
  it('rejects spring gaps, chooses first autumn fold, handles near midnight and all-day DST spans', () => {
    expect(wallInstant('2026-03-08', '02:30', 'America/New_York')).toBeUndefined();
    expect(wallInstant('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(wallInstant('2026-10-06', '23:30', 'America/New_York')).toBe('2026-10-07T03:30:00.000Z');
    expect(
      eventWindow(
        [
          {
            ...base,
            date: '2026-03-07',
            endDate: '2026-03-09',
            allDay: true,
            recurrence: { frequency: 'none' },
          },
        ],
        [],
        '2026-03-06',
        '2026-03-10',
      ).map((e) => e.occurrenceDate),
    ).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
  });
  it('validates date/time, plain text lengths and mutually exclusive recurrence ends', () => {
    expect(eventSchema.safeParse({ ...base, notes: 'x'.repeat(2001) }).success).toBe(false);
    expect(
      eventSchema.safeParse({
        ...base,
        recurrence: { frequency: 'daily', count: 3, until: '2026-10-30' },
      }).success,
    ).toBe(false);
    expect(
      eventSchema.safeParse({ ...base, recurrence: { frequency: 'weekly', interval: 0 } }).success,
    ).toBe(false);
  });
});

it('labels timed multi-day continuations without suggesting a fresh start each day', () => {
  const projections = eventWindow(
    [{ ...base, endDate: '2026-10-08', recurrence: { frequency: 'none' } }],
    [],
    '2026-10-06',
    '2026-10-08',
  );
  expect(projections.map(eventTimeLabel)).toEqual(['5:30 PM', 'Continues', 'Continues']);
  expect(projections.map((e) => e.startTime)).toEqual(['17:30', '17:30', '17:30']);
  expect(eventTimeLabel({ ...projections[1], allDay: true })).toBe('All day');
});
