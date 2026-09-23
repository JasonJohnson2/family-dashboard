import { z } from 'zod';
import { ApiError } from '../database';
import { readJson } from '../http';
import { calendarSettings, configureCalendar, discover, sync } from './calendar';
import {
  authorizeManagement,
  callback,
  configured,
  connect,
  disconnect,
  stateCookie,
} from './oauth';
import { connection } from './storage';
import { automaticSync } from './automatic';
import { syncStatus } from './status';
import type { GoogleEnv } from './types';

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
export async function googleRoute(request: Request, env: GoogleEnv) {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/api/google/refresh') {
      // Public capability is limited to checking status / refreshing already-enabled stale data.
      // Only the manual flag may bypass staleness; its durable short cooldown still applies.
      if (request.method === 'GET') return json(await syncStatus(env.DB));
      if (request.method !== 'POST') throw new ApiError(405, 'Use GET or POST for refresh.');
      if (
        request.headers.get('Origin') !== new URL(request.url).origin ||
        request.headers.get('Sec-Fetch-Site') === 'cross-site'
      )
        throw new ApiError(403, 'Use the dashboard origin.', 'google_origin');
      const parsed = z
        .object({ manual: z.boolean().optional() })
        .strict()
        .safeParse(await readJson(request));
      if (!parsed.success)
        throw new ApiError(400, 'Send an empty object or a manual refresh flag.');
      return json({
        ...(await automaticSync(env, parsed.data.manual)),
        status: await syncStatus(env.DB),
      });
    }
    if (path === '/api/google/callback') {
      if (request.method !== 'GET') throw new ApiError(405, 'Use GET for the Google callback.');
      return await callback(request, env);
    }
    await authorizeManagement(request, env);
    if (path === '/api/google/status' && request.method === 'GET') {
      let ready = true;
      try {
        await configured(env);
      } catch {
        ready = false;
      }
      const stored = await connection(env.DB);
      return json({
        configured: ready,
        connected: !!stored,
        accountId: stored?.account_id ?? null,
        email: stored?.account_email ?? null,
        scopes: stored?.scopes.split(' ') ?? [],
        sync: await syncStatus(env.DB),
      });
    }
    if (path === '/api/google/connect' && request.method === 'GET')
      return await connect(request, env);
    if (path === '/api/google/calendars' && request.method === 'GET')
      return json({ calendars: await discover(env) });
    if (path === '/api/google/calendars' && request.method === 'PATCH') {
      const parsed = calendarSettings.safeParse(await readJson(request));
      if (!parsed.success)
        throw new ApiError(
          400,
          'Provide sourceId, enabled, privacyMode (busy, title or full), and an optional memberId (or null to clear it).',
        );
      return json({ calendar: await configureCalendar(env, parsed.data) });
    }
    if (path === '/api/google/sync' && request.method === 'POST') {
      const parsed = z
        .object({ sourceId: z.string().min(1).max(80).optional() })
        .strict()
        .safeParse(await readJson(request));
      if (!parsed.success) throw new ApiError(400, 'Provide an optional sourceId.');
      return json({ synced: await sync(env, parsed.data.sourceId) });
    }
    if (path === '/api/google/disconnect' && request.method === 'POST') {
      const parsed = z
        .object({})
        .strict()
        .safeParse(await readJson(request));
      if (!parsed.success) throw new ApiError(400, 'Send an empty JSON object to disconnect.');
      await disconnect(env);
      return json({ connected: false });
    }
    if (
      ['connect', 'status', 'calendars', 'sync', 'disconnect'].some(
        (p) => path === `/api/google/${p}`,
      )
    )
      throw new ApiError(405, 'This method is not supported.');
    throw new ApiError(404, 'Google API endpoint not found.');
  } catch (error) {
    // Never log Google responses, request URLs/codes, or errors that may include credentials.
    const response =
      error instanceof ApiError
        ? json({ error: error.message, code: error.code }, error.status)
        : json(
            {
              error: 'Google Calendar is unavailable. Check setup and retry.',
              code: 'google_unavailable',
            },
            503,
          );
    if (path === '/api/google/callback') {
      try {
        response.headers.set('Set-Cookie', stateCookie(env, '', 0));
      } catch {
        /* Invalid config must still return a safe error. */
      }
    }
    return response;
  }
}
