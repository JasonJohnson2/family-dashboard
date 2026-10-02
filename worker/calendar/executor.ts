import { z } from 'zod';
import { ApiError } from '../database';
import { readJson } from '../http';
import { refreshCalendarData } from './refresh';
import { automaticSync } from '../google/automatic';
import { syncStatus } from '../google/status';
import { sync } from '../google/calendar';

const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refresh'), manual: z.boolean() }).strict(),
  z.object({ kind: z.literal('google-refresh'), manual: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('google-sync'), sourceId: z.string().min(1).max(80).optional() })
    .strict(),
]);
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });

// Internal binding only. This SQLite-backed class uses no Object storage/alarm:
// existing D1 leases, credentials and atomic commits remain authoritative.
// Heavy imports receive Durable Objects' CPU allowance rather than Free HTTP's 10 ms.
export class CalendarSync implements DurableObject {
  constructor(
    _state: DurableObjectState,
    private readonly env: Env,
  ) {}
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/sync')
        throw new ApiError(404, 'Calendar operation not found.', 'calendar_executor');
      const input = operationSchema.safeParse(await readJson(request));
      if (!input.success)
        throw new ApiError(400, 'Invalid calendar operation.', 'calendar_executor');
      const operation = input.data;
      // Each incoming invocation gets a fresh shared external-request budget.
      const env = { ...this.env, calendarHttpBudget: { remaining: 40 } };
      if (operation.kind === 'refresh')
        return await refreshCalendarData(env, true, operation.manual);
      if (operation.kind === 'google-refresh')
        return json({
          ...(await automaticSync(env, operation.manual)),
          status: await syncStatus(env.DB),
        });
      return json({ synced: await sync(env, operation.sourceId) });
    } catch (error) {
      // Never propagate provider/SQL exception text through the internal binding.
      return error instanceof ApiError
        ? json({ error: error.message, code: error.code }, error.status)
        : json(
            {
              error:
                'Calendar processing is unavailable. Saved events remain available; retry shortly.',
              code: 'calendar_executor',
            },
            503,
          );
    }
  }
}
