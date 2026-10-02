import ICAL from 'ical.js';
import { eventSchema } from '../../src/data/contracts';
import { addDays } from '../../src/lib/dates';
import { hash } from '../google/crypto';
import { localTime } from '../google/normalize';
import { ApiError } from '../database';
import type { Calendar } from './types';

type Time = InstanceType<typeof ICAL.Time>;
type Event = InstanceType<typeof ICAL.Event>;
// ICAL uses VTIMEZONE definitions when supplied. For missing IANA definitions,
// use Worker's Intl database rather than treating TZID wall-clock values as UTC.
export function instant(
  time: Time,
  component: InstanceType<typeof ICAL.Component>,
  property: string,
  fallback: string,
): string {
  if (time.zone.tzid !== 'floating') return new Date(time.toUnixTime() * 1000).toISOString();
  const zone = String(component.getFirstProperty(property)?.getParameter('tzid') || fallback);
  const wall = time.toString().replace(/Z$/, '');
  const guessed = Date.parse(wall + 'Z');
  const desired = wall.slice(0, 16);
  const offsets = new Set<number>();
  for (const shift of [-2 * 86400000, 0, 2 * 86400000]) {
    const probe = guessed + shift,
      local = localTime(new Date(probe).toISOString(), zone);
    offsets.add(Date.parse(`${local.date}T${local.time}:00Z`) - Math.floor(probe / 60000) * 60000);
  }
  const matches = [...offsets]
    .map((offset) => new Date(guessed - offset).toISOString())
    .filter((candidate) => {
      const local = localTime(candidate, zone);
      return `${local.date}T${local.time}` === desired;
    })
    .sort();
  if (!matches.length) throw new Error('Unsupported/nonexistent wall time');
  return matches[0];
}
export async function normalizeIcs(
  ics: string,
  href: string,
  calendar: Calendar,
  zone: string,
  from: string,
  to: string,
) {
  try {
    if (ics.length > 1_000_000) throw new Error();
    const root = ICAL.Component.fromString(ics);
    if (root.name !== 'vcalendar') throw new Error();
    const components = root.getAllSubcomponents('vevent');
    if (components.length > 10000) throw new Error();
    const events = components.map((c) => new ICAL.Event(c, { exceptions: [] }));
    const results = new Map<string, ReturnType<typeof eventSchema.parse>>();
    let steps = 0;
    const cancelled = (event: Event) =>
      String(event.component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED';
    const key = (time: Time, event: Event, property: string) =>
      time.isDate ? time.toString() : instant(time, event.component, property, zone);
    async function project(event: Event, start: Time, end: Time, original: Time) {
      if (cancelled(event)) return;
      const allDay = start.isDate;
      const startInstant = allDay ? undefined : instant(start, event.component, 'dtstart', zone);
      const endInstant = allDay ? undefined : instant(end, event.component, 'dtend', zone);
      const localStart = allDay
        ? { date: start.toString(), time: undefined }
        : localTime(startInstant!, zone);
      const localEnd = allDay
        ? { date: addDays(end.toString(), -1), time: undefined }
        : localTime(endInstant!, zone);
      if (
        allDay
          ? localEnd.date < from.slice(0, 10) || localStart.date >= to.slice(0, 10)
          : endInstant! <= from || startInstant! >= to
      )
        return;
      const externalId = await hash(
        JSON.stringify([
          href,
          event.uid,
          key(original, event, event.isRecurrenceException() ? 'recurrence-id' : 'dtstart'),
        ]),
      );
      const id = `i_${await hash(JSON.stringify([calendar.source_id, externalId]))}`;
      results.set(
        id,
        eventSchema.parse({
          id,
          externalId,
          sourceId: calendar.source_id,
          title:
            calendar.privacy_mode === 'busy'
              ? 'Busy'
              : event.summary?.trim().slice(0, 120) || 'Untitled event',
          date: localStart.date,
          endDate: localEnd.date === localStart.date ? undefined : localEnd.date,
          startTime: localStart.time,
          endTime: localEnd.time,
          allDay,
          timeZone: zone,
          startInstant,
          endInstant,
          memberIds: calendar.member_id ? [calendar.member_id] : [],
          recurrence: { frequency: 'none' },
          ...(calendar.privacy_mode === 'full'
            ? {
                location: event.location?.trim().slice(0, 160),
                notes: event.description?.slice(0, 2000),
              }
            : {}),
        }),
      );
      if (results.size > 10000) throw new Error();
    }
    const masters = events.filter((e) => !e.isRecurrenceException());
    for (const master of masters) {
      if (!master.uid || !master.startDate) throw new Error();
      if (cancelled(master)) continue;
      const exceptions = events.filter((e) => e.uid === master.uid && e.isRecurrenceException());
      for (const exception of exceptions)
        if (!cancelled(exception)) master.relateException(exception);
      const excluded = new Set(
        exceptions.filter(cancelled).map((e) => key(e.recurrenceId, e, 'recurrence-id')),
      );
      if (master.isRecurring()) {
        const iterator = master.iterator();
        let occurrence: Time | null;
        while ((occurrence = iterator.next())) {
          if (++steps > 20000) throw new Error('Expansion limit');
          // Compare original occurrences only after a two-day timezone/override margin.
          if (occurrence.toString().slice(0, 10) > addDays(to.slice(0, 10), 2)) break;
          if (excluded.has(key(occurrence, master, 'dtstart'))) continue;
          const details = master.getOccurrenceDetails(occurrence);
          await project(details.item, details.startDate, details.endDate, occurrence);
        }
      } else await project(master, master.startDate, master.endDate, master.startDate);
    }
    // Expanded CalDAV data may consist entirely of RECURRENCE-ID components.
    // Also include exceptions moved into the window from an original date outside it.
    for (const event of events.filter((e) => e.isRecurrenceException())) {
      if (masters.some((m) => m.uid === event.uid && cancelled(m))) continue;
      if (!cancelled(event))
        await project(event, event.startDate, event.endDate, event.recurrenceId);
    }
    return [...results.values()];
  } catch {
    throw new ApiError(
      502,
      'An iCloud event could not be safely imported. Saved events are unchanged.',
      'icloud_event',
    );
  }
}
