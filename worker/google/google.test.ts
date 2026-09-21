import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '../../scripts/test-database';
import worker from '../index';
import { SCOPES } from './oauth';
import { decryptToken, encryptToken } from './crypto';
import { calendars, commit, connection, withLease } from './storage';
import { eventId, normalizeEvent } from './normalize';
import { readState } from '../database';
import { eventsOn } from '../../src/lib/dates';
import type { GoogleEnv, StoredCalendar } from './types';

// Test-only values, unrelated to any real Google credentials.
const KEY = btoa('01234567890123456789012345678901');
const ADMIN = 'test-management-key-at-least-32-characters';
const REFRESH = 'test-refresh-token-not-a-real-credential';
const ACCESS = 'test-access-token-not-a-real-credential';
const ORIGIN = 'https://home.test';
const rawEvent = (id = 'event-one', summary = 'Sensitive meeting') => ({
  id,
  summary,
  description: 'Private notes',
  location: 'Private location',
  start: { dateTime: '2026-09-21T09:00:00-04:00' },
  end: { dateTime: '2026-09-21T10:00:00-04:00' },
});

describe('Google encryption and event normalization', () => {
  const calendar = { source_id: 'google_test', privacy_mode: 'busy' } as StoredCalendar;
  it('authenticates encrypted refresh tokens, nonce and connection context', async () => {
    const encrypted = await encryptToken(REFRESH, KEY, 'connection');
    expect(encrypted.ciphertext).not.toContain(REFRESH);
    expect(atob(encrypted.ciphertext)).not.toContain(REFRESH);
    expect(await decryptToken(encrypted.ciphertext, encrypted.iv, 1, KEY, 'connection')).toBe(
      REFRESH,
    );
    expect((await encryptToken(REFRESH, KEY, 'connection')).iv).not.toBe(encrypted.iv);
    await expect(decryptToken(encrypted.ciphertext, encrypted.iv, 1, KEY, 'other')).rejects.toThrow(
      'could not be read',
    );
    await expect(
      decryptToken(encrypted.ciphertext, btoa('wrong nonce!'), 1, KEY, 'connection'),
    ).rejects.toThrow();
    await expect(
      decryptToken(encrypted.ciphertext, encrypted.iv, 2, KEY, 'connection'),
    ).rejects.toThrow();
    await expect(encryptToken(REFRESH, 'bad-key', 'connection')).rejects.toThrow('not configured');
  });
  it('projects busy/title/full on the server without leaking unnecessary payload fields', async () => {
    const raw = { ...rawEvent(), attendees: [{ email: 'private@example.test' }] };
    const busy = await normalizeEvent(raw, calendar, 'America/New_York');
    expect(busy?.title).toBe('Busy');
    expect(JSON.stringify(busy)).not.toMatch(/Sensitive|Private|attendees|private@example/);
    const title = await normalizeEvent(
      raw,
      { ...calendar, privacy_mode: 'title' },
      'America/New_York',
    );
    expect(title?.title).toBe(raw.summary);
    expect(title?.notes).toBeUndefined();
    expect(title?.location).toBeUndefined();
    const full = await normalizeEvent(
      raw,
      { ...calendar, privacy_mode: 'full' },
      'America/New_York',
    );
    expect(full?.notes).toBe(raw.description);
    expect(full?.location).toBe(raw.location);
    expect(full?.recurrence).toEqual({ frequency: 'none' });
    expect(full?.externalId).toBe(raw.id);
  });
  it('handles all-day exclusive ends, multi-day intervals, zones, DST and missing optional fields', async () => {
    const allDay = await normalizeEvent(
      { id: 'all', start: { date: '2026-09-21' }, end: { date: '2026-09-24' } },
      calendar,
      'America/New_York',
    );
    expect(allDay).toMatchObject({ date: '2026-09-21', endDate: '2026-09-23', allDay: true });
    expect(eventsOn([allDay!], '2026-09-24')).toHaveLength(0);
    const zoned = await normalizeEvent(rawEvent(), calendar, 'Europe/London');
    expect(zoned).toMatchObject({
      startTime: '14:00',
      endTime: '15:00',
      timeZone: 'Europe/London',
    });
    const midnight = await normalizeEvent(
      {
        id: 'midnight',
        start: { dateTime: '2026-09-21T23:00:00-04:00' },
        end: { dateTime: '2026-09-22T00:00:00-04:00' },
      },
      calendar,
      'America/New_York',
    );
    expect(eventsOn([midnight!], '2026-09-22')).toHaveLength(0);
    const fold = await normalizeEvent(
      {
        id: 'fold',
        start: { dateTime: '2026-11-01T01:45:00-04:00' },
        end: { dateTime: '2026-11-01T01:15:00-05:00' },
      },
      calendar,
      'America/New_York',
    );
    expect(fold).toMatchObject({
      startTime: '01:45',
      endTime: '01:15',
      startInstant: '2026-11-01T05:45:00.000Z',
      endInstant: '2026-11-01T06:15:00.000Z',
    });
    expect(await normalizeEvent({ id: 'gone', status: 'cancelled' }, calendar, 'UTC')).toBeNull();
    await expect(normalizeEvent({ id: 'invalid' }, calendar, 'UTC')).rejects.toThrow();
    const untitled = await normalizeEvent(
      { ...rawEvent(), summary: undefined },
      { ...calendar, privacy_mode: 'title' },
      'UTC',
    );
    expect(untitled?.title).toBe('Untitled event');
  });
});

describe('Google Worker API with real D1 and mocked Google HTTP', () => {
  let runtime: ReturnType<typeof createDatabase>, db: D1Database, env: GoogleEnv;
  let google: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  let requests: { url: URL; init?: RequestInit }[];
  beforeEach(async () => {
    runtime = createDatabase();
    db = (await runtime.getD1Database('DB')) as unknown as D1Database;
    await migrate(db);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
    env = {
      DB: db,
      ASSETS: { fetch: async () => new Response('shell') } as Fetcher,
      GOOGLE_APP_ORIGIN: ORIGIN,
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_TOKEN_ENCRYPTION_KEY: KEY,
      GOOGLE_ADMIN_KEY: ADMIN,
    };
    requests = [];
    google = (url) => {
      if (url.hostname === 'oauth2.googleapis.com')
        return Response.json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: SCOPES.join(' '),
        });
      if (url.pathname.endsWith('calendarList'))
        return Response.json({
          items: [
            {
              id: 'primary@example.test',
              summary: 'Work',
              backgroundColor: '#123456',
              primary: true,
            },
          ],
        });
      return Response.json({ items: [rawEvent()], nextSyncToken: 'sync-one' });
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        requests.push({ url, init });
        expect(['oauth2.googleapis.com', 'www.googleapis.com']).toContain(url.hostname);
        if (url.hostname === 'www.googleapis.com') expect(init?.method ?? 'GET').toBe('GET');
        return google(url, init);
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await runtime.dispose();
  });
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    worker.fetch(
      new Request(`${ORIGIN}/api/google/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${ADMIN}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  async function begin() {
    const response = await call('connect');
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { authorizationUrl: string }).authorizationUrl);
    return { url, cookie: response.headers.get('Set-Cookie')!.split(';')[0] };
  }
  async function finish(start: Awaited<ReturnType<typeof begin>>, extra = 'code=test-code') {
    return call(
      `callback?state=${start.url.searchParams.get('state')}&${extra}`,
      'GET',
      undefined,
      { Cookie: start.cookie },
    );
  }
  async function connected() {
    const response = await finish(await begin());
    expect(response.status, await response.clone().text()).toBe(303);
  }
  async function selected(mode = 'busy') {
    await connected();
    expect((await call('calendars')).status).toBe(200);
    const c = (await calendars(db))[0];
    expect(
      (
        await call('calendars', 'PATCH', {
          sourceId: c.source_id,
          enabled: true,
          privacyMode: mode,
        })
      ).status,
    ).toBe(200);
    return c.source_id;
  }
  async function synced(source?: string) {
    const response = await call('sync', 'POST', source ? { sourceId: source } : {});
    expect(response.status, await response.clone().text()).toBe(200);
    return readState(db);
  }
  it('uses read-only scopes, PKCE, browser-bound single-use state and encrypted storage', async () => {
    const start = await begin();
    expect(start.url.origin).toBe('https://accounts.google.com');
    expect(start.url.searchParams.get('scope')?.split(' ')).toEqual(SCOPES);
    expect(start.url.searchParams.get('access_type')).toBe('offline');
    expect(start.url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/google/callback`);
    expect(start.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.cookie).toMatch(/^__Host-google_oauth=/);
    expect(
      (await call(`callback?state=${start.url.searchParams.get('state')}&code=test`)).status,
    ).toBe(400);
    const response = await finish(start);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`${ORIGIN}/#calendar`);
    expect((await finish(start)).status).toBe(400);
    const stored = await connection(db);
    expect(JSON.stringify(stored)).not.toContain(REFRESH);
    expect(
      await decryptToken(stored!.refresh_ciphertext, stored!.refresh_iv, 1, KEY, stored!.id),
    ).toBe(REFRESH);
    const status = await (await call('status')).text();
    expect(status).toContain('"connected":true');
    for (const value of [REFRESH, ACCESS, KEY, 'test-client-secret'])
      expect(status).not.toContain(value);
    expect((await call('connect')).status).toBe(409);
  });
  it('rejects expired/invalid state and handles denied, missing-code and missing-refresh callbacks safely', async () => {
    let start = await begin();
    expect(
      (await call('callback?state=invalid&code=test', 'GET', undefined, { Cookie: start.cookie }))
        .status,
    ).toBe(400);
    await db.prepare('UPDATE google_oauth_states SET expires_at=0').run();
    expect((await finish(start)).status).toBe(400);
    start = await begin();
    expect((await finish(start, 'error=access_denied')).status).toBe(400);
    expect((await finish(start)).status).toBe(400);
    start = await begin();
    expect((await finish(start, '')).status).toBe(400);
    google = () => Response.json({ access_token: ACCESS, expires_in: 3600 });
    start = await begin();
    const missing = await finish(start);
    expect(await missing.text()).toContain('google_refresh_missing');
    expect(await connection(db)).toBeNull();
    google = () => Response.json({ error_description: REFRESH }, { status: 400 });
    start = await begin();
    const failed = await finish(start);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(REFRESH);
  });
  it('requires management authorization and keeps the household working without Google secrets', async () => {
    expect((await call('sync', 'POST', {}, { Authorization: '' })).status).toBe(401);
    expect((await call('calendars', 'PATCH', {}, { Origin: 'https://evil.test' })).status).toBe(
      403,
    );
    expect((await call('disconnect', 'GET')).status).toBe(405);
    expect((await call('sync', 'POST', { events: [rawEvent()] })).status).toBe(400);
    env.GOOGLE_CLIENT_SECRET = undefined;
    expect((await call('connect')).status).toBe(503);
    expect(await (await call('status')).json()).toMatchObject({
      configured: false,
      connected: false,
    });
    expect((await worker.fetch(new Request(`${ORIGIN}/api/household`), env)).status).toBe(200);
  });
  it('discovers paginated calendars as disabled busy sources, preserving settings on rediscovery', async () => {
    await connected();
    const normal = google;
    google = (url, init) =>
      url.pathname.endsWith('calendarList')
        ? Response.json(
            url.searchParams.has('pageToken')
              ? { items: [{ id: 'shared', summary: 'Shared', backgroundColor: 'bad' }] }
              : {
                  items: [
                    {
                      id: 'primary@example.test',
                      summary: 'Work',
                      primary: true,
                      backgroundColor: '#123456',
                    },
                  ],
                  nextPageToken: 'page2',
                },
          )
        : normal(url, init);
    const response = await call('calendars');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/refresh_|access_token|sync_token/);
    let found = await calendars(db);
    expect(found).toHaveLength(2);
    expect(found.every((c) => !c.enabled && c.privacy_mode === 'busy')).toBe(true);
    expect(found.find((c) => c.google_id === 'shared')?.color).toBe('#4285f4');
    const first = found[0];
    await call('calendars', 'PATCH', {
      sourceId: first.source_id,
      enabled: true,
      privacyMode: 'title',
    });
    await call('calendars');
    found = await calendars(db);
    expect(found.find((c) => c.source_id === first.source_id)).toMatchObject({
      enabled: 1,
      privacy_mode: 'title',
    });
    expect((await readState(db)).events).toHaveLength(0);
    expect((await connection(db))?.account_email).toBe('primary@example.test');
  });
  it('commits paginated full and incremental sync, updates, cancellations and deterministic identities', async () => {
    const source = await selected('full');
    const normal = google;
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? Response.json(
            url.searchParams.has('pageToken')
              ? { items: [rawEvent('second')], nextSyncToken: 'initial' }
              : { items: [rawEvent()], nextPageToken: 'page2' },
          )
        : normal(url, init);
    let state = await synced(source);
    expect(state.events).toHaveLength(2);
    expect(state.events[0].notes).toBe('Private notes');
    const id = state.events.find((e) => e.externalId === 'event-one')!.id;
    expect((await calendars(db))[0].sync_token).toBe('initial');
    const initialRequests = requests.filter((r) => r.url.pathname.endsWith('/events'));
    expect(initialRequests[0].url.searchParams.get('singleEvents')).toBe('true');
    expect(initialRequests.every((r) => r.url.searchParams.has('timeMin'))).toBe(true);
    requests = [];
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? Response.json(
            url.searchParams.has('pageToken')
              ? { items: [{ id: 'second', status: 'cancelled' }], nextSyncToken: 'incremental' }
              : { items: [rawEvent('event-one', 'Updated')], nextPageToken: 'delta-page' },
          )
        : normal(url, init);
    state = await synced(source);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ id, title: 'Updated' });
    const incremental = requests.filter((r) => r.url.pathname.endsWith('/events'));
    expect(incremental).toHaveLength(2);
    for (const r of incremental) {
      expect(r.url.searchParams.get('syncToken')).toBe('initial');
      expect(r.url.searchParams.has('timeMin')).toBe(false);
      expect(r.url.searchParams.has('timeMax')).toBe(false);
    }
    await synced(source);
    expect((await readState(db)).events).toHaveLength(1);
    expect((await calendars(db))[0].sync_token).toBe('incremental');
  });
  it('restarts after 410 and removes stale imports only after the replacement succeeds', async () => {
    const source = await selected();
    await synced(source);
    const normal = google;
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? url.searchParams.has('syncToken')
          ? new Response(null, { status: 410 })
          : Response.json({ items: [rawEvent('replacement')], nextSyncToken: 'replacement-token' })
        : normal(url, init);
    const state = await synced(source);
    expect(state.events.map((e) => e.externalId)).toEqual(['replacement']);
    expect((await calendars(db))[0].sync_token).toBe('replacement-token');
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? url.searchParams.has('syncToken')
          ? new Response(null, { status: 410 })
          : new Response('unavailable', { status: 503 })
        : normal(url, init);
    expect((await call('sync', 'POST', {})).status).toBe(502);
    expect((await calendars(db))[0].sync_token).toBeNull();
    expect((await readState(db)).events[0].externalId).toBe('replacement');
  });
  it('does not commit partial pages or advance a token on Google errors', async () => {
    const source = await selected();
    await synced(source);
    const before = await readState(db),
      normal = google;
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? url.searchParams.has('pageToken')
          ? new Response('bad', { status: 500 })
          : Response.json({ items: [rawEvent('partial')], nextPageToken: 'next' })
        : normal(url, init);
    expect((await call('sync', 'POST', {})).status).toBe(502);
    expect((await readState(db)).events).toEqual(before.events);
    expect((await calendars(db))[0].sync_token).toBe('sync-one');
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? Response.json({ items: [], nextPageToken: 'loop' })
        : normal(url, init);
    expect((await call('sync', 'POST', {})).status).toBe(502);
    expect((await readState(db)).events).toEqual(before.events);
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? Response.json({ items: [rawEvent('missing-token')] })
        : normal(url, init);
    expect((await call('sync', 'POST', {})).status).toBe(502);
    expect((await readState(db)).events).toEqual(before.events);
  });
  it('imports more than one SQL chunk and renews the window only when due', async () => {
    const source = await selected();
    const normal = google;
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? Response.json({
            items: Array.from({ length: 205 }, (_, i) => rawEvent(`event-${i}`)),
            nextSyncToken: 'bulk',
          })
        : normal(url, init);
    expect((await synced(source)).events).toHaveLength(205);
    requests = [];
    expect((await synced(source)).events).toHaveLength(205);
    expect(
      requests.find((r) => r.url.pathname.endsWith('/events'))?.url.searchParams.get('syncToken'),
    ).toBe('bulk');
    await db.prepare("UPDATE google_calendars SET full_synced_at='2026-08-01T12:00:00Z'").run();
    requests = [];
    await synced(source);
    expect(
      requests.find((r) => r.url.pathname.endsWith('/events'))?.url.searchParams.has('syncToken'),
    ).toBe(false);
  });
  it('removes inaccessible calendar imports on rediscovery and leaves other sources alone', async () => {
    await selected();
    await synced();
    const normal = google;
    google = (url, init) =>
      url.pathname.endsWith('calendarList') ? Response.json({ items: [] }) : normal(url, init);
    expect((await call('calendars')).status).toBe(200);
    expect(await calendars(db)).toHaveLength(0);
    const state = await readState(db);
    expect(state.events).toHaveLength(0);
    expect(state.sources.map((s) => s.id)).toEqual(['local']);
    expect(await connection(db)).not.toBeNull();
  });
  it('refreshes access tokens, retries one 401 and reports revoked refresh tokens without leaking', async () => {
    const source = await selected();
    const normal = google;
    let unauthorized = true;
    google = (url, init) => {
      if (url.pathname.endsWith('/events') && unauthorized) {
        unauthorized = false;
        return new Response(null, { status: 401 });
      }
      return normal(url, init);
    };
    await synced(source);
    expect(
      requests.filter(
        (r) =>
          r.url.hostname === 'oauth2.googleapis.com' &&
          String(r.init?.body).includes('grant_type=refresh_token'),
      ).length,
    ).toBeGreaterThanOrEqual(3);
    google = () => Response.json({ error_description: `${REFRESH} ${ACCESS}` }, { status: 400 });
    const response = await call('sync', 'POST', {});
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(new RegExp(`${REFRESH}|${ACCESS}`));
  });
  it('clears old private projections immediately on privacy changes and disabling', async () => {
    const source = await selected('full');
    await synced(source);
    for (const privacyMode of ['title', 'busy']) {
      expect(
        (await call('calendars', 'PATCH', { sourceId: source, enabled: true, privacyMode })).status,
      ).toBe(200);
      expect((await readState(db)).events).toHaveLength(0);
      const state = await synced(source);
      expect(state.events[0].notes).toBeUndefined();
      expect(state.events[0].location).toBeUndefined();
      if (privacyMode === 'busy') expect(state.events[0].title).toBe('Busy');
      const rows = JSON.stringify((await db.prepare('SELECT * FROM events').all()).results);
      expect(rows).not.toContain('Private');
    }
    await call('calendars', 'PATCH', { sourceId: source, enabled: false, privacyMode: 'busy' });
    expect((await readState(db)).events).toHaveLength(0);
    expect((await call('sync', 'POST', { sourceId: source })).status).toBe(404);
  });
  it('protects imports from ordinary mutations and does not overwrite a local event on identity collision', async () => {
    const source = await selected();
    const collision = await eventId(source, 'event-one');
    await db
      .prepare(
        "INSERT INTO events (household_id,id,sourceId,title,date,allDay,timeZone,recurrence) VALUES ('home',?,'local','Local plan','2026-09-21',1,'UTC','{\"frequency\":\"none\"}')",
      )
      .bind(collision)
      .run();
    await synced(source);
    expect((await readState(db)).events.find((e) => e.id === collision)).toMatchObject({
      sourceId: 'local',
      title: 'Local plan',
    });
    const normal = google;
    google = (url, init) =>
      url.pathname.endsWith('/events')
        ? Response.json({ items: [rawEvent('another')], nextSyncToken: 'new' })
        : normal(url, init);
    const state = await synced(source),
      imported = state.events.find((e) => e.sourceId === source)!;
    const mutation = (operations: unknown[]) =>
      worker.fetch(
        new Request(`${ORIGIN}/api/mutations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            revision: state.household.revision,
            operations,
          }),
        }),
        env,
      );
    expect((await mutation([{ type: 'event.put', value: imported }])).status).toBe(400);
    expect(
      (
        await mutation([
          {
            type: 'event.put',
            value: {
              ...imported,
              sourceId: 'local',
              startInstant: undefined,
              endInstant: undefined,
            },
          },
        ])
      ).status,
    ).toBe(400);
    expect((await mutation([{ type: 'delete', entity: 'event', id: imported.id }])).status).toBe(
      400,
    );
  });
  it('disconnect removes owned tokens, mappings and imports, keeping local records intact', async () => {
    const source = await selected();
    await synced(source);
    await db
      .prepare(
        "INSERT INTO events (household_id,id,sourceId,title,date,allDay,timeZone,recurrence) VALUES ('home','local-plan','local','Local plan','2026-09-21',1,'UTC','{\"frequency\":\"none\"}')",
      )
      .run();
    expect((await call('disconnect', 'POST', {})).status).toBe(200);
    expect(await connection(db)).toBeNull();
    expect(await calendars(db)).toHaveLength(0);
    const state = await readState(db);
    expect(state.events.map((e) => e.id)).toEqual(['local-plan']);
    expect(state.sources.map((s) => s.id)).toEqual(['local']);
    expect((await call('disconnect', 'POST', {})).status).toBe(200);
  });
  it('fences expired leases and prevents overlapping sync/disconnect commits', async () => {
    await connected();
    await withLease(db, async (lease) => {
      expect((await call('disconnect', 'POST', {})).status).toBe(409);
      await db.prepare('UPDATE google_operation_locks SET expires_at=0').run();
      await expect(
        commit(lease, [db.prepare("UPDATE households SET name='must roll back' WHERE id='home'")]),
      ).rejects.toThrow('could not be committed');
      expect((await readState(db)).household.name).toBe('Our Home');
    });
  });
});
