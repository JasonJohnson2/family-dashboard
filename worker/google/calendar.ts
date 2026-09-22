import { z } from 'zod';
import { idSchema } from '../../src/data/contracts';
import { ApiError, HOUSEHOLD_ID } from '../database';
import { accessToken } from './oauth';
import { assignImportedEvents, calendars, commit, connection, withLease } from './storage';
import { eventId, normalizeEvent, sourceId } from './normalize';
import type { GoogleEnv, StoredCalendar } from './types';
import type { CalendarEvent } from '../../src/types';

const calendarSchema = z.object({
  id: z.string().min(1).max(500),
  summary: z.string().optional(),
  backgroundColor: z.string().optional(),
  primary: z.boolean().optional(),
  deleted: z.boolean().optional(),
  accessRole: z.string().optional(),
});
const timeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});
const googleEventSchema = z.object({
  id: z.string().min(1).max(500),
  status: z.string().optional(),
  eventType: z.string().optional(),
  workingLocationProperties: z.object({ type: z.string().optional() }).nullable().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: timeSchema.optional(),
  end: timeSchema.optional(),
});
const pageToken = z.string().min(1).max(4096).optional();
const calendarPage = z.object({
  items: z.array(calendarSchema).default([]),
  nextPageToken: pageToken,
});
const eventPage = z.object({
  items: z.array(googleEventSchema).default([]),
  nextPageToken: pageToken,
  nextSyncToken: pageToken,
});
class Gone extends Error {}
export function googleClient(env: GoogleEnv) {
  let token: string | undefined;
  return async <T>(path: string, query: URLSearchParams, schema: z.ZodType<T>): Promise<T> => {
    token ??= await accessToken(env);
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(`https://www.googleapis.com/calendar/v3/${path}?${query}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new ApiError(
          502,
          'Google Calendar could not be reached. Retry shortly.',
          'google_unavailable',
        );
      }
      if (response.status === 401 && attempt === 0) {
        token = await accessToken(env);
        continue;
      }
      if (response.status === 410) throw new Gone();
      if (!response.ok)
        throw new ApiError(
          502,
          'Google Calendar could not be read. Check permissions or retry later.',
          'google_api',
        );
      try {
        return schema.parse(await response.json());
      } catch {
        throw new ApiError(
          502,
          'Google returned an invalid calendar response. Retry later.',
          'google_response',
        );
      }
    }
    throw new ApiError(502, 'Google access expired. Reconnect the account.', 'google_token');
  };
}
export function safeCalendar(c: StoredCalendar) {
  return {
    googleId: c.google_id,
    sourceId: c.source_id,
    name: c.name,
    color: c.color,
    primary: !!c.is_primary,
    enabled: !!c.enabled,
    privacyMode: c.privacy_mode,
    memberId: c.member_id ?? null,
    lastSyncedAt: c.last_synced_at,
  };
}
export async function discover(env: GoogleEnv) {
  return withLease(env.DB, async (lease) => {
    const stored = await connection(env.DB);
    if (!stored) throw new ApiError(409, 'Connect Google first.', 'google_not_connected');
    const get = googleClient(env),
      found = new Map<string, z.infer<typeof calendarSchema>>();
    let next: string | undefined;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({
        maxResults: '250',
        minAccessRole: 'reader',
        fields: 'items(id,summary,backgroundColor,primary,deleted,accessRole),nextPageToken',
      });
      if (next) query.set('pageToken', next);
      const page = await get('users/me/calendarList', query, calendarPage);
      for (const c of page.items)
        if (!c.deleted && c.accessRole !== 'none' && c.accessRole !== 'freeBusyReader')
          found.set(c.id, c);
      next = page.nextPageToken;
      if (next && (seen.has(next) || seen.size >= 19))
        throw new ApiError(
          502,
          'Google calendar discovery exceeded its page limit. Retry later.',
          'google_pagination',
        );
      if (next) seen.add(next);
    } while (next);
    const old = await calendars(env.DB),
      statements: D1PreparedStatement[] = [];
    for (const c of found.values()) {
      const id = await sourceId(stored.id, c.id),
        name = c.summary?.trim().slice(0, 120) || 'Google calendar',
        color = /^#[a-fA-F0-9]{6}$/.test(c.backgroundColor ?? '') ? c.backgroundColor! : '#4285f4';
      const prior = old.find((calendar) => calendar.google_id === c.id);
      statements.push(
        env.DB.prepare(
          "INSERT INTO calendar_sources (household_id,id,name,provider,color) VALUES (?,?,?,'google',?) ON CONFLICT(household_id,id) DO UPDATE SET name=excluded.name,color=excluded.color WHERE calendar_sources.provider='google'",
        ).bind(
          HOUSEHOLD_ID,
          id,
          prior && prior.privacy_mode !== 'busy' ? name : 'Google calendar',
          color,
        ),
        env.DB.prepare(
          'INSERT INTO google_calendars (household_id,google_id,source_id,name,color,is_primary) VALUES (?,?,?,?,?,?) ON CONFLICT(household_id,google_id) DO UPDATE SET name=excluded.name,color=excluded.color,is_primary=excluded.is_primary',
        ).bind(HOUSEHOLD_ID, c.id, id, name, color, Number(!!c.primary)),
      );
    }
    for (const c of old.filter((c) => !found.has(c.google_id)))
      statements.push(
        env.DB.prepare('DELETE FROM events WHERE household_id=? AND sourceId=?').bind(
          HOUSEHOLD_ID,
          c.source_id,
        ),
        env.DB.prepare('DELETE FROM google_calendars WHERE household_id=? AND google_id=?').bind(
          HOUSEHOLD_ID,
          c.google_id,
        ),
        env.DB.prepare(
          "DELETE FROM calendar_sources WHERE household_id=? AND id=? AND provider='google'",
        ).bind(HOUSEHOLD_ID, c.source_id),
      );
    const primary = [...found.values()].find((c) => c.primary);
    if (primary)
      statements.push(
        env.DB.prepare(
          'UPDATE google_connections SET account_id=?,account_email=?,updated_at=CURRENT_TIMESTAMP WHERE household_id=?',
        ).bind(primary.id, /^[^\s@]+@[^\s@]+$/.test(primary.id) ? primary.id : null, HOUSEHOLD_ID),
      );
    await commit(lease, statements);
    return (await calendars(env.DB)).map(safeCalendar);
  });
}
export const calendarSettings = z
  .object({
    sourceId: z.string().min(1).max(80),
    enabled: z.boolean(),
    privacyMode: z.enum(['busy', 'title', 'full']),
    memberId: idSchema.nullable().optional(),
  })
  .strict();
export async function configureCalendar(
  env: GoogleEnv,
  settings: z.infer<typeof calendarSettings>,
) {
  return withLease(env.DB, async (lease) => {
    const c = (await calendars(env.DB)).find((c) => c.source_id === settings.sourceId);
    if (!c) throw new ApiError(404, 'Discover this Google calendar first.', 'google_calendar');
    const memberId = settings.memberId === undefined ? c.member_id : settings.memberId;
    if (
      memberId &&
      !(await env.DB.prepare('SELECT id FROM members WHERE household_id=? AND id=?')
        .bind(HOUSEHOLD_ID, memberId)
        .first())
    )
      throw new ApiError(400, 'Choose an existing household member.', 'google_member');
    const projectionChanged =
      !!c.enabled !== settings.enabled || c.privacy_mode !== settings.privacyMode;
    const memberChanged = memberId !== c.member_id;
    if (!projectionChanged && !memberChanged) return safeCalendar(c);
    const statements: D1PreparedStatement[] = [];
    if (projectionChanged)
      statements.push(
        // Removing all old projections makes privacy changes immediate, even when Google is down.
        env.DB.prepare('DELETE FROM events WHERE household_id=? AND sourceId=?').bind(
          HOUSEHOLD_ID,
          c.source_id,
        ),
        env.DB.prepare(
          'UPDATE google_calendars SET enabled=?,privacy_mode=?,sync_token=NULL,last_synced_at=NULL,full_synced_at=NULL WHERE household_id=? AND source_id=?',
        ).bind(Number(settings.enabled), settings.privacyMode, HOUSEHOLD_ID, c.source_id),
        env.DB.prepare(
          "UPDATE calendar_sources SET name=? WHERE household_id=? AND id=? AND provider='google'",
        ).bind(
          settings.privacyMode === 'busy' ? 'Google calendar' : c.name,
          HOUSEHOLD_ID,
          c.source_id,
        ),
      );
    if (memberChanged) {
      statements.push(
        memberId
          ? env.DB.prepare(
              'INSERT INTO google_calendar_members (household_id,source_id,member_id) VALUES (?,?,?) ON CONFLICT(household_id,source_id) DO UPDATE SET member_id=excluded.member_id',
            ).bind(HOUSEHOLD_ID, c.source_id, memberId)
          : env.DB.prepare(
              'DELETE FROM google_calendar_members WHERE household_id=? AND source_id=?',
            ).bind(HOUSEHOLD_ID, c.source_id),
      );
      statements.push(...assignImportedEvents(env.DB, c.source_id, memberId));
    }
    await commit(lease, statements);
    return safeCalendar((await calendars(env.DB)).find((c) => c.source_id === settings.sourceId)!);
  });
}
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
export async function sync(env: GoogleEnv, requestedSource?: string) {
  return withLease(env.DB, async (lease) => {
    if (!(await connection(env.DB)))
      throw new ApiError(409, 'Connect Google first.', 'google_not_connected');
    const selected = (await calendars(env.DB)).filter(
      (c) => !!c.enabled && (!requestedSource || c.source_id === requestedSource),
    );
    if (requestedSource && !selected.length)
      throw new ApiError(404, 'Enable this Google calendar before syncing.', 'google_calendar');
    const get = googleClient(env),
      results: { sourceId: string; imported: number; full: boolean }[] = [];
    const household = await env.DB.prepare('SELECT timeZone FROM households WHERE id=?')
      .bind(HOUSEHOLD_ID)
      .first<{ timeZone: string }>();
    for (const calendar of selected) {
      const zone = household!.timeZone,
        now = new Date();
      let full =
        calendar.projection_version !== 1 ||
        !calendar.sync_token ||
        !calendar.full_synced_at ||
        Date.now() - Date.parse(calendar.full_synced_at) > 30 * 86400000 ||
        calendar.sync_time_zone !== zone;
      let windowStart = full
        ? new Date(now.valueOf() - 30 * 86400000).toISOString()
        : calendar.window_start!;
      let windowEnd = full
        ? new Date(now.valueOf() + 365 * 86400000).toISOString()
        : calendar.window_end!;
      let imported: CalendarEvent[] = [],
        removed: string[] = [],
        syncToken: string | undefined;
      for (let pass = 0; pass < 2; pass++) {
        imported = [];
        removed = [];
        let next: string | undefined;
        const seen = new Set<string>();
        try {
          do {
            const query = new URLSearchParams({
              singleEvents: 'true',
              showDeleted: 'true',
              maxResults: '250',
              timeZone: zone,
              fields: `items(id,status,eventType,workingLocationProperties(type),start,end${calendar.privacy_mode !== 'busy' ? ',summary' : ''}${calendar.privacy_mode === 'full' ? ',description,location' : ''}),nextPageToken,nextSyncToken`,
            });
            if (full) {
              query.set('timeMin', windowStart);
              query.set('timeMax', windowEnd);
            } else query.set('syncToken', calendar.sync_token!);
            if (next) query.set('pageToken', next);
            const page = await get(
              `calendars/${encodeURIComponent(calendar.google_id)}/events`,
              query,
              eventPage,
            );
            for (const raw of page.items) {
              const normalized = await normalizeEvent(raw, calendar, zone);
              // Incremental responses may contain changes outside the initial window.
              if (
                !normalized ||
                (normalized.endDate ?? normalized.date) < windowStart.slice(0, 10) ||
                normalized.date > windowEnd.slice(0, 10)
              )
                removed.push(await eventId(calendar.source_id, raw.id));
              else imported.push(normalized);
            }
            next = page.nextPageToken;
            syncToken = page.nextSyncToken;
            if (next && (seen.has(next) || seen.size >= 39))
              throw new ApiError(
                502,
                'Google sync exceeded its page limit. Previous data is unchanged.',
                'google_pagination',
              );
            if (next) seen.add(next);
          } while (next);
          if (!syncToken)
            throw new ApiError(
              502,
              'Google omitted the next sync token. Previous data is unchanged.',
              'google_sync_token',
            );
          break;
        } catch (error) {
          if (!(error instanceof Gone) || full || pass > 0)
            throw error instanceof Gone
              ? new ApiError(
                  502,
                  'Google could not restart synchronization. Retry later.',
                  'google_sync_token',
                )
              : error;
          full = true;
          windowStart = new Date(now.valueOf() - 30 * 86400000).toISOString();
          windowEnd = new Date(now.valueOf() + 365 * 86400000).toISOString();
          // Drop the invalid token but keep the last safe display until a complete replacement succeeds.
          await commit(lease, [
            env.DB.prepare(
              'UPDATE google_calendars SET sync_token=NULL WHERE household_id=? AND source_id=?',
            ).bind(HOUSEHOLD_ID, calendar.source_id),
          ]);
        }
      }
      const statements: D1PreparedStatement[] = [];
      if (full)
        statements.push(
          env.DB.prepare('DELETE FROM events WHERE household_id=? AND sourceId=?').bind(
            HOUSEHOLD_ID,
            calendar.source_id,
          ),
        );
      statements.push(...putEvents(env.DB, imported));
      if (removed.length)
        statements.push(
          env.DB.prepare(
            'DELETE FROM events WHERE household_id=? AND sourceId=? AND id IN (SELECT value FROM json_each(?))',
          ).bind(HOUSEHOLD_ID, calendar.source_id, JSON.stringify(removed)),
        );
      statements.push(...assignImportedEvents(env.DB, calendar.source_id, calendar.member_id));
      statements.push(
        env.DB.prepare(
          'UPDATE google_calendars SET sync_token=?,window_start=?,window_end=?,sync_time_zone=?,last_synced_at=?,full_synced_at=?,projection_version=1 WHERE household_id=? AND source_id=?',
        ).bind(
          syncToken!,
          windowStart,
          windowEnd,
          zone,
          now.toISOString(),
          full ? now.toISOString() : calendar.full_synced_at,
          HOUSEHOLD_ID,
          calendar.source_id,
        ),
      );
      await commit(lease, statements);
      results.push({ sourceId: calendar.source_id, imported: imported.length, full });
    }
    return results;
  });
}
