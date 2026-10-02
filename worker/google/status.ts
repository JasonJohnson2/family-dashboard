import { ApiError, HOUSEHOLD_ID } from '../database';
import { calendars, connection } from './storage';
import type { StoredCalendar } from './types';

import { STALE_MS, RETRY_MS, MANUAL_RETRY_MS } from '../calendar/policy';
export { STALE_MS, RETRY_MS, MANUAL_RETRY_MS } from '../calendar/policy';
export type SyncFailure = 'authorization' | 'configuration' | 'unavailable';

// Persist only our own categories, never provider messages or exception text.
export function syncFailure(error: unknown): SyncFailure {
  if (error instanceof ApiError) {
    if (['google_token', 'google_scopes'].includes(error.code)) return 'authorization';
    if (['google_configuration', 'google_credentials'].includes(error.code)) return 'configuration';
  }
  return 'unavailable';
}
export function isStale(calendar: StoredCalendar, now = Date.now()) {
  return !calendar.last_synced_at || now - Date.parse(calendar.last_synced_at) >= STALE_MS;
}
export function isDue(calendar: StoredCalendar, manual = false, now = Date.now()) {
  return (
    (manual || isStale(calendar, now)) &&
    (!calendar.last_attempt_at ||
      now - Date.parse(calendar.last_attempt_at) >= (manual ? MANUAL_RETRY_MS : RETRY_MS))
  );
}
export async function syncStatus(db: D1Database) {
  const stored = await connection(db),
    connected = !!stored;
  const enabled = (await calendars(db)).filter((c) => c.enabled);
  const lock = await db
    .prepare('SELECT expires_at FROM google_operation_locks WHERE household_id=?')
    .bind(HOUSEHOLD_ID)
    .first<{ expires_at: number }>();
  const failed = enabled
    .filter((c) => c.last_sync_error)
    .sort((a, b) => (b.last_attempt_at ?? '').localeCompare(a.last_attempt_at ?? ''));
  return {
    connected,
    enabledCalendars: enabled.length,
    // Oldest successful timestamp across enabled calendars; null until all have synced.
    lastSyncedAt:
      enabled.length && enabled.every((c) => c.last_synced_at)
        ? enabled.map((c) => c.last_synced_at!).sort()[0]
        : null,
    stale: enabled.some((c) => isStale(c)),
    syncing: !!lock && lock.expires_at > Date.now(),
    needsAttention:
      !!stored?.last_connection_error || !!stored?.requires_reconnect || failed.length > 0,
    requiresReconnect: !!stored?.requires_reconnect,
    lastFailure: stored?.last_connection_error ?? failed[0]?.last_sync_error ?? null,
  };
}
