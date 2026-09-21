import { eventSchema } from '../../src/data/contracts';
import { addDays } from '../../src/lib/dates';
import { ApiError } from '../database';
import { hash } from './crypto';
import type { GoogleEvent, StoredCalendar } from './types';

export const sourceId = async (connectionId: string, googleId: string) =>
  `google_${await hash(JSON.stringify([connectionId, googleId]))}`;
export const eventId = async (source: string, externalId: string) =>
  `g_${await hash(JSON.stringify([source, externalId]))}`;
export function localTime(instant: string, timeZone: string) {
  const date = new Date(instant);
  if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(instant) || !Number.isFinite(date.valueOf()))
    throw new ApiError(502, 'Google returned an invalid event time.', 'google_event');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
export async function normalizeEvent(raw: GoogleEvent, calendar: StoredCalendar, timeZone: string) {
  if (raw.status === 'cancelled') return null;
  const allDay = !!raw.start?.date;
  let date: string, endDate: string, startTime: string | undefined, endTime: string | undefined;
  if (allDay) {
    date = raw.start!.date!;
    endDate = raw.end?.date ? addDays(raw.end.date, -1) : date;
  } else {
    if (!raw.start?.dateTime || !raw.end?.dateTime)
      throw new ApiError(
        502,
        'Google returned an event without valid start/end times.',
        'google_event',
      );
    const start = localTime(raw.start.dateTime, timeZone),
      end = localTime(raw.end.dateTime, timeZone);
    date = start.date;
    endDate = end.date;
    startTime = start.time;
    endTime = end.time;
  }
  const parsed = eventSchema.safeParse({
    id: await eventId(calendar.source_id, raw.id),
    sourceId: calendar.source_id,
    externalId: raw.id,
    title:
      calendar.privacy_mode === 'busy'
        ? 'Busy'
        : raw.summary?.trim().slice(0, 120) || 'Untitled event',
    date,
    endDate: endDate === date ? undefined : endDate,
    startTime,
    endTime,
    allDay,
    timeZone,
    startInstant: allDay ? undefined : new Date(raw.start!.dateTime!).toISOString(),
    endInstant: allDay ? undefined : new Date(raw.end!.dateTime!).toISOString(),
    memberIds: [],
    recurrence: { frequency: 'none' },
    ...(calendar.privacy_mode === 'full'
      ? { location: raw.location?.trim().slice(0, 160), notes: raw.description?.slice(0, 2000) }
      : {}),
  });
  if (!parsed.success)
    throw new ApiError(
      502,
      'Google returned an event that could not be imported. The previous sync is unchanged.',
      'google_event',
    );
  return parsed.data;
}
