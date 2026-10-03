import { ApiError, HOUSEHOLD_ID } from '../database';
export type SyncOperation =
  | { kind: 'refresh'; manual: boolean }
  | { kind: 'google-refresh'; manual: boolean }
  | { kind: 'google-sync'; sourceId?: string }
  | { kind: 'local-window'; from: string; to: string };

// Call only after the public route has checked household/operator permissions
// and validated input. Do not forward cookies, OAuth state or browser headers.
export async function executeCalendarSync(env: Env, operation: SyncOperation) {
  if (!env.CALENDAR_SYNC)
    throw new ApiError(
      503,
      'Calendar sync processing is not configured. Check the Worker binding.',
      'calendar_executor',
    );
  const id = env.CALENDAR_SYNC.idFromName(HOUSEHOLD_ID);
  return env.CALENDAR_SYNC.get(id).fetch(
    new Request('https://calendar.internal/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation),
    }),
  );
}
