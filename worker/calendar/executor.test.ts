import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate, seed } from '../../scripts/test-database';
import { testSession } from '../../scripts/test-auth';
import { executeCalendarSync } from './execution';
import { refreshCalendars } from './refresh';
import { readState } from '../database';
let runtime: Miniflare | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

it('executes shared and legacy sync routes in a real SQLite-backed Object and keeps the internal endpoint private', async () => {
  const bundle = await build({
    entryPoints: ['worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-09-19',
      d1Databases: ['DB'],
      bindings: {
        GOOGLE_ADMIN_KEY: 'fixture-admin-secret-not-real-at-least-32-characters',
        GOOGLE_APP_ORIGIN: 'https://dashboard.test',
      },
      durableObjects: { CALENDAR_SYNC: { className: 'CalendarSync', useSQLite: true } },
    }),
  );
  const db = (await runtime.getD1Database('DB')) as unknown as D1Database;
  await migrate(db);
  await seed(db);
  const cookie = await testSession(db),
    before = await readState(db);
  const request = (path: string, body: unknown = {}, authenticated = true) =>
    runtime!.dispatchFetch(`https://dashboard.test${path}`, {
      method: 'POST',
      headers: {
        Origin: 'https://dashboard.test',
        'Content-Type': 'application/json',
        ...(authenticated ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  expect((await request('/api/calendar/refresh', {}, false)).status).toBe(401);
  const response = await request('/api/calendar/refresh', { manual: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    outcome: 'complete',
    synced: 0,
    status: { enabledCalendars: 0 },
    providers: { google: { outcome: 'complete' }, icloud: { outcome: 'complete' } },
  });
  expect(await (await request('/api/google/refresh')).json()).toMatchObject({
    outcome: 'complete',
    synced: 0,
  });
  expect((await request('/api/google/sync')).status).toBe(401);
  const managed = await runtime.dispatchFetch('https://dashboard.test/api/google/sync', {
    method: 'POST',
    headers: {
      Origin: 'https://dashboard.test',
      'Content-Type': 'application/json',
      Cookie: cookie,
      Authorization: 'Bearer fixture-admin-secret-not-real-at-least-32-characters',
    },
    body: '{}',
  });
  expect(managed.status).toBe(409);
  expect(await managed.json()).toMatchObject({ code: 'google_not_connected' });
  expect((await request('/api/calendar/executor', { kind: 'google-sync' })).status).toBe(404);
  const namespace = await runtime.getDurableObjectNamespace('CALENDAR_SYNC');
  const invalid = await namespace
    .get(namespace.idFromName('home'))
    .fetch('https://calendar.internal/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"kind":"disconnect"}',
    });
  expect(invalid.status).toBe(400);
  expect(await readState(db)).toEqual(before);
}, 60000);

it('forwards only validated operation data to the household Object and fails closed without its binding', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ synced: 1 }));
  const id = {} as DurableObjectId;
  const namespace = {
    idFromName: vi.fn().mockReturnValue(id),
    get: vi.fn().mockReturnValue({ fetch }),
  };
  const env = { CALENDAR_SYNC: namespace } as unknown as Env;
  const request = new Request('https://dashboard.test/api/calendar/refresh', {
    method: 'POST',
    headers: {
      Origin: 'https://dashboard.test',
      'Content-Type': 'application/json',
      Cookie: 'fixture-private-cookie',
      Authorization: 'fixture-private-header',
    },
    body: '{"manual":true}',
  });
  expect((await refreshCalendars(request, env)).status).toBe(200);
  expect(namespace.idFromName).toHaveBeenCalledWith('home');
  const forwarded: Request = fetch.mock.calls[0][0];
  expect(Object.fromEntries(forwarded.headers)).toEqual({ 'content-type': 'application/json' });
  expect(await forwarded.json()).toEqual({ kind: 'refresh', manual: true });
  expect(namespace.get).toHaveBeenCalledWith(id);
  await expect(
    executeCalendarSync({} as Env, { kind: 'refresh', manual: true }),
  ).rejects.toMatchObject({ status: 503, code: 'calendar_executor' });
  const bad = new Request('https://dashboard.test/api/calendar/refresh', {
    method: 'POST',
    headers: { Origin: 'https://other.test', 'Content-Type': 'application/json' },
    body: '{}',
  });
  await expect(refreshCalendars(bad, env)).rejects.toMatchObject({ status: 403 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
