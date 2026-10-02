// Test-only in-process binding for suites that mock provider HTTP in Node.
// A separate workerd integration test exercises the real SQLite-backed Object.
import { CalendarSync } from '../worker/calendar/executor';
export function withTestCalendarExecutor(env: Env): Env {
  if (env.CALENDAR_SYNC) return env;
  const executor = new CalendarSync({} as DurableObjectState, env);
  return {
    ...env,
    CALENDAR_SYNC: {
      idFromName: () => ({ toString: () => 'fixture' }),
      get: () => ({ fetch: (request: Request) => executor.fetch(request) }),
    } as unknown as DurableObjectNamespace,
  };
}
