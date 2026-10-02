import { ApiError } from '../database';
import { sameOrigin } from '../household-auth';
import { readJson } from '../http';
import { requireRewardOperator } from '../reward-operator';
import { calendarSettings } from '../calendar/settings';
import { encryptionKey } from '../calendar/credentials';
import {
  connect,
  connectSchema,
  connection,
  calendars,
  configure,
  discover,
  disconnect,
  keyFor,
  safeCalendar,
  status,
} from './service';
import { z } from 'zod';
export async function icloudRoute(request: Request, env: Env) {
  sameOrigin(request);
  await requireRewardOperator(request, env);
  const path = new URL(request.url).pathname;
  const json = (body: unknown) =>
    Response.json(body, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  if (path === '/api/icloud/status' && request.method === 'GET') {
    let configured = true;
    try {
      await encryptionKey(keyFor(env), 'icloud');
    } catch {
      configured = false;
    }
    const c = await connection(env.DB);
    return json({
      configured,
      connected: !!c,
      account: c?.account ?? null,
      sync: await status(env.DB),
      calendars: (await calendars(env.DB)).map(safeCalendar),
    });
  }
  if (path === '/api/icloud/connect' && request.method === 'POST') {
    const input = connectSchema.safeParse(await readJson(request));
    if (!input.success)
      throw new ApiError(
        400,
        'Enter your Apple Account email and an Apple app-specific password (xxxx-xxxx-xxxx-xxxx). Never use your normal Apple Account password.',
        'icloud_input',
      );
    return json(await connect(env, input.data));
  }
  if (path === '/api/icloud/calendars' && request.method === 'GET')
    return json({ calendars: await discover(env) });
  if (path === '/api/icloud/calendars' && request.method === 'PATCH') {
    const input = calendarSettings.safeParse(await readJson(request));
    if (!input.success)
      throw new ApiError(
        400,
        'Choose the calendar, enabled state, privacy and household member.',
        'icloud_input',
      );
    return json({ calendar: await configure(env, input.data) });
  }
  if (path === '/api/icloud/disconnect' && request.method === 'POST') {
    if (
      !z
        .object({})
        .strict()
        .safeParse(await readJson(request)).success
    )
      throw new ApiError(400, 'Send an empty object to disconnect.');
    await disconnect(env);
    return json({ connected: false });
  }
  throw new ApiError(405, 'This iCloud operation or method is not supported.');
}
