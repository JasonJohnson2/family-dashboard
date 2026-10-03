import type {
  CalendarEvent,
  EventException,
  EventOccurrence,
  LocalEventChange,
  EventRecurrenceRule,
} from '../types';
import { civilDay, dayDifference, weekday, monthDay } from './calendarDates';

const week = (d: string) => civilDay(d, -((weekday(d) + 6) % 7));
const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthLength = (year: number, month: number) =>
  [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
function monthlyNumber(start: string, index: number, rule: EventRecurrenceRule) {
  const year = Math.floor(index / 12),
    month = index % 12,
    length = monthLength(year, month);
  if (!rule.monthWeek) {
    const n = Number(start.slice(8));
    return n <= length ? n : undefined;
  }
  const first = new Date(Date.UTC(year, month, 1, 12)).getUTCDay(),
    day = rule.byWeekday![0];
  if (rule.monthWeek === -1) return length - ((first + length - 1 - day + 7) % 7);
  const n = 1 + ((day - first + 7) % 7) + (rule.monthWeek - 1) * 7;
  return n <= length ? n : undefined;
}
function monthlyDate(start: string, index: number, rule: EventRecurrenceRule) {
  const day = monthlyNumber(start, index, rule);
  return day
    ? String(Math.floor(index / 12)).padStart(4, '0') +
        '-' +
        String((index % 12) + 1).padStart(2, '0') +
        '-' +
        String(day).padStart(2, '0')
    : undefined;
}
// Rank an occurrence without walking every day since DTSTART. Monthly/yearly ranks
// walk calendar periods only when COUNT is present; local dates are bounded to 1900..2199.
export function recurrenceIndex(event: CalendarEvent, target: string): number | undefined {
  const start = event.date,
    r = event.recurrence,
    interval = r.interval ?? 1;
  if (target < start || (r.until && target > r.until)) return;
  let index: number | undefined;
  if (r.frequency === 'none') index = target === start ? 0 : undefined;
  else if (r.frequency === 'daily') {
    const n = dayDifference(start, target);
    if (n % interval === 0) index = n / interval;
  } else if (r.frequency === 'weekly' || r.frequency === 'weekdays') {
    const days = r.frequency === 'weekdays' ? [1, 2, 3, 4, 5] : (r.byWeekday ?? [weekday(start)]);
    const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const weeks = dayDifference(week(start), week(target)) / 7;
    const eligible = r.frequency === 'weekdays' ? 1 : interval;
    if (weeks % eligible === 0 && days.includes(weekday(target))) {
      const initial = ordered.filter((d) => (d + 6) % 7 >= (weekday(start) + 6) % 7);
      index =
        weeks === 0
          ? initial.indexOf(weekday(target))
          : initial.length +
            (weeks / eligible - 1) * days.length +
            ordered.indexOf(weekday(target));
    }
  } else {
    const delta =
      r.frequency === 'monthly'
        ? monthIndex(target) - monthIndex(start)
        : Number(target.slice(0, 4)) - Number(start.slice(0, 4));
    if (delta % interval) return;
    const candidate =
      r.frequency === 'monthly'
        ? monthlyDate(start, monthIndex(target), r)
        : monthDay(
            Number(target.slice(0, 4)),
            Number(start.slice(5, 7)) - 1,
            Number(start.slice(8)),
          );
    if (candidate !== target) return;
    index = 0;
    if (r.count) {
      for (let n = 0; n <= delta; n += interval) {
        const year = Number(start.slice(0, 4)) + n;
        const day =
          r.frequency === 'monthly'
            ? monthlyNumber(start, monthIndex(start) + n, r)
            : Number(start.slice(8)) <= monthLength(year, Number(start.slice(5, 7)) - 1)
              ? Number(start.slice(8))
              : undefined;
        if (day && (n !== 0 || day >= Number(start.slice(8)))) index++;
      }
      index--;
    }
  }
  return index !== undefined && index >= 0 && (!r.count || index < r.count) ? index : undefined;
}
export function occurrence(event: CalendarEvent, start: string): CalendarEvent {
  return {
    ...event,
    date: start,
    endDate: event.endDate ? civilDay(start, dayDifference(event.date, event.endDate)) : undefined,
  };
}
export function eventDays(
  events: CalendarEvent[],
  exceptions: EventException[],
  day: string,
): EventOccurrence[] {
  return eventWindow(events, exceptions, day, day);
}
export function eventWindow(
  events: CalendarEvent[],
  exceptions: EventException[],
  from: string,
  to: string,
) {
  const length = dayDifference(from, to);
  if (length < 0 || length > 61) throw new Error('Choose a calendar window of at most 62 days.');
  const result: EventOccurrence[] = [];
  const emit = (master: CalendarEvent, value: CalendarEvent, nominal: string, modified = false) => {
    const start = value.date > from ? value.date : from;
    let end = value.endDate ?? value.date;
    if (!value.allDay && value.endTime === '00:00' && end !== value.date) end = civilDay(end, -1);
    if (end > to) end = to;
    for (let day = start; day <= end; day = civilDay(day, 1)) {
      if (result.length >= 10000)
        throw new Error(
          'This calendar window contains too many overlapping occurrences. Choose fewer days.',
        );
      result.push({
        ...value,
        id: master.id,
        recurrence: master.recurrence,
        occurrenceDate: day,
        recurrenceDate: nominal,
        isException: modified,
        occurrenceId: master.id + ':' + nominal + (nominal === day ? '' : ':' + day),
      });
    }
  };
  for (const master of events) {
    const overrides = exceptions.filter((e) => e.eventId === master.id),
      excluded = new Set(overrides.map((e) => e.recurrenceDate));
    if (master.recurrence.frequency === 'none') emit(master, master, master.date);
    else {
      const span = Math.min(
        366,
        Math.max(0, dayDifference(master.date, master.endDate ?? master.date)),
      );
      const boundary = civilDay(from, -span),
        start = boundary > master.date ? boundary : master.date;
      // Examine only possible start dates that can overlap this window, once per series.
      for (let day = start; day <= to; day = civilDay(day, 1))
        if (!excluded.has(day) && recurrenceIndex(master, day) !== undefined)
          emit(master, occurrence(master, day), day);
    }
    for (const e of overrides)
      if (!e.cancelled && e.value) emit(master, e.value, e.recurrenceDate, true);
  }
  return result.sort(
    (a, b) =>
      a.occurrenceDate.localeCompare(b.occurrenceDate) ||
      (a.allDay ? '' : a.date < a.occurrenceDate ? '00:00' : (a.startTime ?? '')).localeCompare(
        b.allDay ? '' : b.date < b.occurrenceDate ? '00:00' : (b.startTime ?? ''),
      ),
  );
}
export function recurrenceLabel(r: EventRecurrenceRule) {
  if (r.frequency === 'none') return 'Does not repeat';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const unit =
    r.frequency === 'weekdays'
      ? 'weekday'
      : { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.frequency];
  const n = r.interval ?? 1;
  return (
    'Every ' +
    (n === 1 ? '' : n + ' ') +
    unit +
    (n > 1 ? 's' : '') +
    (r.byWeekday?.length
      ? ' · ' +
        (r.monthWeek
          ? ({ 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', '-1': 'last' }[
              r.monthWeek
            ] ?? '') + ' '
          : '') +
        r.byWeekday.map((d) => days[d]).join(', ')
      : '') +
    (r.until ? ' · through ' + r.until : r.count ? ' · ' + r.count + ' occurrences' : '')
  );
}
const timing = (e: CalendarEvent) =>
  JSON.stringify([e.date, e.endDate, e.startTime, e.endTime, e.allDay, e.timeZone, e.recurrence]);
export function applyLocalEventChange(
  events: CalendarEvent[],
  exceptions: EventException[],
  change: LocalEventChange,
) {
  let next = [...events],
    ex = [...exceptions];
  const put = (v: CalendarEvent) => {
    next = [...next.filter((e) => e.id !== v.id), v];
  };
  const remove = (id: string) => {
    next = next.filter((e) => e.id !== id);
    ex = ex.filter((e) => e.eventId !== id);
  };
  if (change.type === 'event.put') {
    const old = next.find((e) => e.id === change.value.id);
    if (old && timing(old) !== timing(change.value)) ex = ex.filter((e) => e.eventId !== old.id);
    put(change.value);
  } else if (change.type === 'delete') remove(change.id);
  else {
    const master = next.find((e) => e.id === change.id);
    if (!master) throw new Error('This event no longer exists.');
    const target = change.recurrenceDate;
    if (recurrenceIndex(master, target) === undefined)
      throw new Error('Choose an existing occurrence of this series.');
    if (master.recurrence.frequency === 'none' || change.scope === 'all') {
      if (change.type === 'event.delete') remove(master.id);
      else {
        if (timing(master) !== timing(change.value)) ex = ex.filter((e) => e.eventId !== master.id);
        put({ ...change.value, id: master.id, createdAt: master.createdAt });
      }
    } else if (change.scope === 'this') {
      ex = ex.filter((e) => !(e.eventId === master.id && e.recurrenceDate === target));
      ex.push({
        eventId: master.id,
        recurrenceDate: target,
        cancelled: change.type === 'event.delete',
        value:
          change.type === 'event.edit'
            ? {
                ...change.value,
                id: master.id,
                recurrence: { frequency: 'none' },
                createdAt: master.createdAt,
              }
            : undefined,
      });
    } else {
      // Truncate the old master without rewriting or materializing its historical occurrences.
      const oldExceptions = ex.filter((e) => e.eventId === master.id && e.recurrenceDate >= target);
      ex = ex.filter((e) => e.eventId !== master.id || e.recurrenceDate < target);
      if (target === master.date) remove(master.id);
      else
        put({
          ...master,
          recurrence: { ...master.recurrence, until: civilDay(target, -1), count: undefined },
        });
      if (change.type === 'event.edit') {
        if (!change.newSeriesId) throw new Error('A future series needs its own identifier.');
        const index = recurrenceIndex(
          {
            ...master,
            recurrence: { ...master.recurrence, count: master.recurrence.count ?? 10000 },
          },
          target,
        )!;
        const value = {
          ...change.value,
          id: change.newSeriesId,
          externalId: undefined,
          createdAt: undefined,
          recurrence: {
            ...change.value.recurrence,
            count:
              change.value.recurrence.count &&
              JSON.stringify(change.value.recurrence) === JSON.stringify(master.recurrence)
                ? Math.max(1, change.value.recurrence.count - index)
                : change.value.recurrence.count,
          },
        };
        put(value);
        const projected = occurrence(master, target);
        if (timing(projected) === timing(change.value))
          ex.push(
            ...oldExceptions.map((e) => ({
              ...e,
              eventId: value.id,
              value: e.value ? { ...e.value, id: value.id } : undefined,
            })),
          );
      }
    }
  }
  return { events: next, eventExceptions: ex };
}
