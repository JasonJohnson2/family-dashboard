import { applyLocalEventChange, recurrenceIndex } from '../../src/lib/localCalendar';
import { dayDifference } from '../../src/lib/calendarDates';
import { wallInstant } from '../../src/lib/eventTime';
import type { HouseholdState, Operation } from '../../src/data/contracts';
import type { CalendarEvent } from '../../src/types';
import { ApiError } from '../database';
export const isCalendarChange = (op: Operation) =>
  op.type === 'event.put' ||
  op.type === 'event.edit' ||
  op.type === 'event.delete' ||
  (op.type === 'delete' && op.entity === 'event');
export function validateLocalCalendar(state: HouseholdState, operations: Operation[]) {
  let events = state.events,
    eventExceptions = state.eventExceptions;
  const members = new Set(state.family.map((m) => m.id));
  for (const op of operations) {
    if (op.type === 'member.put') members.add(op.value.id);
    if (
      op.type === 'delete' &&
      op.entity === 'member' &&
      eventExceptions.some((e) => e.value?.memberIds.includes(op.id))
    )
      throw new ApiError(
        400,
        'This member is assigned to a modified calendar occurrence. Reassign it first.',
      );
    if (!isCalendarChange(op)) continue;
    if (
      op.type !== 'event.put' &&
      op.type !== 'event.edit' &&
      op.type !== 'event.delete' &&
      op.type !== 'delete'
    )
      continue;
    const id = op.type === 'event.put' ? op.value.id : op.id;
    const old = events.find((e) => e.id === id);
    if (
      id.startsWith('g_') ||
      id.startsWith('i_') ||
      (old && old.sourceId !== 'local') ||
      state.sources.find((s) => s.id === 'local')?.provider !== 'local'
    )
      throw new ApiError(400, 'Imported calendar events are read only.');
    if (op.type !== 'event.put' && !old) throw new ApiError(404, 'This event no longer exists.');
    if (op.type === 'event.edit' || op.type === 'event.delete') {
      if (
        op.recurrenceDate < '1900-01-01' ||
        op.recurrenceDate > '2199-12-31' ||
        recurrenceIndex(old!, op.recurrenceDate) === undefined
      )
        throw new ApiError(400, 'Choose an existing occurrence of this series.');
      if (
        op.type === 'event.edit' &&
        op.scope === 'future' &&
        old!.recurrence.frequency !== 'none' &&
        (!op.newSeriesId ||
          op.newSeriesId.startsWith('g_') ||
          op.newSeriesId.startsWith('i_') ||
          events.some((e) => e.id === op.newSeriesId))
      )
        throw new ApiError(400, 'Use a new identifier for the future series.');
    }
    if (op.type === 'event.put' || op.type === 'event.edit') {
      const v = op.value;
      if (v.id !== id || v.sourceId !== 'local' || v.startInstant || v.endInstant)
        throw new ApiError(400, 'Dashboard events must use the local calendar.');
      if (v.memberIds.some((id) => !members.has(id)))
        throw new ApiError(400, 'An assigned family member no longer exists.');
      if (
        v.date < '1900-01-01' ||
        (v.endDate ?? v.date) > '2199-12-31' ||
        dayDifference(v.date, v.endDate ?? v.date) > 366
      )
        throw new ApiError(400, 'Use dates from 1900–2199 and a span of at most 367 days.');
      if (!v.allDay) {
        const start = wallInstant(v.date, v.startTime!, v.timeZone),
          end = wallInstant(v.endDate ?? v.date, v.endTime!, v.timeZone);
        if (!start || !end || end <= start)
          throw new ApiError(
            400,
            'Choose valid start/end times. This time may not exist during a daylight-saving change.',
          );
      }
    }
    try {
      ({ events, eventExceptions } = applyLocalEventChange(
        events,
        eventExceptions,
        op as Parameters<typeof applyLocalEventChange>[2],
      ));
    } catch (e) {
      throw new ApiError(400, e instanceof Error ? e.message : 'Check this calendar change.');
    }
  }
}
export function calendarTimestamp(value: CalendarEvent, old?: CalendarEvent): CalendarEvent {
  const now = new Date().toISOString();
  return { ...value, createdAt: old?.createdAt ?? now, updatedAt: now };
}
