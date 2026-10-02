import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import rawWorker from '../index';
import {
  authenticatedWorker as worker,
  testSession,
  shareTestSession,
} from '../../scripts/test-auth';
import { createDatabase, migrate, seed, applyMigration } from '../../scripts/test-database';
import { readState } from '../database';
import { calendars, connection, sync, configure, discover, disconnect } from './service';
import { encryptSecret, decryptSecret } from '../calendar/credentials';
import { normalizeIcs } from './normalize';
import { client, discovery, safeUrl, resourceUrl, xml, escapeXml, DAV, CAL } from './dav';
import { withLease, commit } from '../calendar/lease';
import { providerFetch } from '../calendar/requestBudget';
import type { Calendar } from './types';
const KEY = btoa('01234567890123456789012345678901'),
  PASSWORD = 'abcd-efgh-ijkl-mnop',
  ACCOUNT = 'fixture@example.test',
  ORIGIN = 'https://home.test',
  HOME = 'https://p01-caldav.icloud.com/account/calendars/',
  URL = HOME + 'family/';
const fixture = (name: string) => readFileSync(`worker/icloud/fixtures/${name}`, 'utf8');
const multistatus = (rows: string, token = '') =>
  `<d:multistatus xmlns:d="DAV:" xmlns:c="${CAL}">${rows}${token ? `<d:sync-token>${escapeXml(token)}</d:sync-token>` : ''}</d:multistatus>`;
const row = (href: string, props: string) =>
  `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const response = (body: string) => new Response(body, { status: 207 });
const sample = (
  title = 'Sensitive title',
  day = new Date().toISOString().slice(0, 10).replaceAll('-', ''),
) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-one\r\nDTSTART:${day}T130000Z\r\nDTEND:${day}T140000Z\r\nSUMMARY:${title}\r\nLOCATION:Private location\r\nDESCRIPTION:Private notes\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const dummy = {
  source_id: 'icloud_fixture',
  privacy_mode: 'full',
  member_id: 'chosen',
} as Calendar;
describe('CalDAV parsing, recurrence and credential isolation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reads individual calendar resources with the shared budget, safe URLs and complete ETag-bearing responses', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response(sample(), { headers: { ETag: 'one' } }));
    vi.stubGlobal('fetch', fetch);
    const budget = { remaining: 1 },
      get = client(ACCOUNT, PASSWORD, budget);
    expect(await get.resource(URL + 'a.ics', URL)).toEqual({ etag: 'one', ics: sample() });
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: { Accept: 'text/calendar' },
    });
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    expect(new Headers(fetch.mock.calls[0][1].headers).has('Depth')).toBe(false);
    await expect(get.resource(URL + 'b.ics', URL)).rejects.toMatchObject({
      code: 'calendar_limit',
    });
    await expect(
      client(ACCOUNT, PASSWORD).resource('https://evil.test/a.ics', URL),
    ).rejects.toThrow('unsupported');
    for (const response of [
      new Response(sample()),
      new Response(sample(), { status: 206, headers: { ETag: 'one' } }),
    ]) {
      fetch.mockResolvedValueOnce(response);
      await expect(client(ACCOUNT, PASSWORD).resource(URL + 'a.ics', URL)).rejects.toMatchObject({
        code: 'icloud_response',
      });
    }
  });
  it('distinguishes timeouts from transport failures without exposing exception text', async () => {
    for (const [error, code] of [
      [new DOMException(PASSWORD, 'TimeoutError'), 'icloud_timeout'],
      [new DOMException(PASSWORD, 'AbortError'), 'icloud_timeout'],
      [new TypeError(PASSWORD), 'icloud_network'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
      await expect(client(ACCOUNT, PASSWORD)(URL, 'REPORT', '')).rejects.toMatchObject({ code });
      await expect(client(ACCOUNT, PASSWORD)(URL, 'REPORT', '')).rejects.not.toThrow(PASSWORD);
    }
  });
  it('bounds external requests across providers and follows only validated Apple redirects', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { Location: 'https://p02-caldav.icloud.com/account/' },
        }),
      )
      .mockResolvedValue(response(multistatus(row('/account/', '<d:resourcetype/>'))));
    vi.stubGlobal('fetch', fetch);
    const budget = { remaining: 2 };
    const result = await client(ACCOUNT, PASSWORD, budget)(
      'https://caldav.icloud.com/',
      'PROPFIND',
      '',
    );
    expect(result.url).toBe('https://p02-caldav.icloud.com/account/');
    expect(budget.remaining).toBe(0);
    expect(() => providerFetch('https://www.googleapis.com/', {}, budget)).toThrow('request limit');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      xml('<multistatus xmlns="DAV:"><response><href>/x</href></response></multistatus>').ns,
    ).toBe(DAV);
  });
  it('uses namespaces, relative URLs and ignores missing optional/failed properties', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          multistatus(
            row(
              '/',
              '<d:current-user-principal><d:href>/account/principal/</d:href></d:current-user-principal>',
            ),
          ),
        ),
      )
      .mockResolvedValueOnce(
        response(
          multistatus(
            row(
              '/account/principal/',
              `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>`,
            ),
          ),
        ),
      )
      .mockResolvedValueOnce(response(fixture('discovery.xml')));
    vi.stubGlobal('fetch', fetch);
    const found = await discovery(client(ACCOUNT, PASSWORD));
    expect(found.calendars).toEqual([
      { url: URL, name: 'Family & Friends', color: '#aabbcc', supportsSync: true },
      { url: HOME + 'personal/', name: 'iCloud calendar', color: '#748bc0', supportsSync: false },
    ]);
    expect(fetch.mock.calls.map((c) => c[1].method)).toEqual(['PROPFIND', 'PROPFIND', 'PROPFIND']);
    expect(fetch.mock.calls[0][1].redirect).toBe('manual');
  });
  it('rejects malformed XML, entities, foreign URLs, redirects, missing principal and overlarge bodies safely', async () => {
    for (const text of ['<broken', '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]><x/>'])
      expect(() => xml(text)).toThrow();
    for (const url of [
      'http://caldav.icloud.com/',
      'https://caldav.icloud.com.evil.test/',
      'https://evil.test/',
      'https://user:pw@caldav.icloud.com/',
      'https://caldav.icloud.com/?password=x',
      'https://p01-caldav.icloud.com:123/',
    ])
      expect(() => safeUrl(url)).toThrow();
    expect(() => resourceUrl('../other.ics', URL)).toThrow();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }),
        ),
    );
    await expect(client(ACCOUNT, PASSWORD)(URL, 'PROPFIND', '')).rejects.toThrow('unsupported');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(multistatus(''))));
    await expect(discovery(client(ACCOUNT, PASSWORD))).rejects.toThrow('principal');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(2_000_001))));
    await expect(client(ACCOUNT, PASSWORD)(URL, 'PROPFIND', '')).rejects.toThrow(
      'could not be read',
    );
  });
  it('preserves Google v1 encryption while binding iCloud secrets to a distinct purpose and connection', async () => {
    // Produce a credential using the original Google v1 algorithm, independently
    // of the shared helper, so this verifies existing production ciphertext.
    const legacyIv = crypto.getRandomValues(new Uint8Array(12));
    const legacyKey = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(KEY), (c) => c.charCodeAt(0)),
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const legacyCiphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: legacyIv,
        additionalData: new TextEncoder().encode('google-refresh:v1:home:legacy-id'),
      },
      legacyKey,
      new TextEncoder().encode('fixture-google-refresh'),
    );
    expect(
      await decryptSecret(
        btoa(String.fromCharCode(...new Uint8Array(legacyCiphertext))),
        btoa(String.fromCharCode(...legacyIv)),
        1,
        KEY,
        'legacy-id',
      ),
    ).toBe('fixture-google-refresh');
    const encrypted = await encryptSecret(PASSWORD, KEY, 'id', 'icloud-app-password', 'icloud');
    expect(encrypted.ciphertext).not.toContain(PASSWORD);
    expect(
      await decryptSecret(
        encrypted.ciphertext,
        encrypted.iv,
        1,
        KEY,
        'id',
        'icloud-app-password',
        'icloud',
      ),
    ).toBe(PASSWORD);
    await expect(decryptSecret(encrypted.ciphertext, encrypted.iv, 1, KEY, 'id')).rejects.toThrow();
    await expect(
      decryptSecret(
        encrypted.ciphertext,
        encrypted.iv,
        1,
        KEY,
        'wrong',
        'icloud-app-password',
        'icloud',
      ),
    ).rejects.toThrow();
  });
  it('handles RRULE, EXDATE, moved and cancelled exceptions, all-day recurrence, Unicode and both DST boundaries', async () => {
    const events = await normalizeIcs(
      fixture('recurrence.ics'),
      URL + 'r.ics',
      dummy,
      'America/New_York',
      '2026-03-01T00:00:00Z',
      '2026-12-01T00:00:00Z',
    );
    expect(events).toHaveLength(6);
    expect(
      events
        .filter((e) => e.title.includes('café'))
        .map((e) => [e.date, e.startTime, e.startInstant]),
    ).toEqual([
      ['2026-03-01', '09:00', '2026-03-01T14:00:00.000Z'],
      ['2026-03-08', '11:00', '2026-03-08T15:00:00.000Z'],
    ]);
    expect(events.filter((e) => e.title === 'Fall morning').map((e) => e.startInstant)).toEqual([
      '2026-10-25T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
    ]);
    expect(events.filter((e) => e.allDay).map((e) => [e.date, e.endDate])).toEqual([
      ['2026-03-03', '2026-03-04'],
      ['2026-03-05', '2026-03-06'],
    ]);
    expect(
      events.every((e) => e.memberIds[0] === 'chosen' && e.recurrence.frequency === 'none'),
    ).toBe(true);
    expect(events[0].notes).toBe('Private notes\nSecond line');
    const second = await normalizeIcs(
      fixture('recurrence.ics'),
      URL + 'r.ics',
      dummy,
      'America/New_York',
      '2026-03-01T00:00:00Z',
      '2026-12-01T00:00:00Z',
    );
    expect(second).toEqual(events);
  });
  it('handles IANA zones without VTIMEZONE, floating times, expanded recurrence and privacy before persistence', async () => {
    const data =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:dst\r\nDTSTART;TZID=America/New_York:20260301T090000\r\nDTEND;TZID=America/New_York:20260301T100000\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nSUMMARY:Private title\r\nLOCATION:Private place\r\nDESCRIPTION:Private note\r\nEND:VEVENT\r\nEND:VCALENDAR';
    for (const privacy_mode of ['busy', 'title', 'full'] as const) {
      const events = await normalizeIcs(
        data,
        URL + 'missing-zone.ics',
        { ...dummy, privacy_mode, member_id: null },
        'America/New_York',
        '2026-03-01T00:00:00Z',
        '2026-04-01T00:00:00Z',
      );
      expect(events.map((e) => e.startInstant)).toEqual([
        '2026-03-01T14:00:00.000Z',
        '2026-03-08T13:00:00.000Z',
      ]);
      expect(events[0].memberIds).toEqual([]);
      if (privacy_mode === 'busy') expect(JSON.stringify(events)).not.toContain('Private');
      if (privacy_mode !== 'full') {
        expect(events[0].notes).toBeUndefined();
        expect(events[0].location).toBeUndefined();
      }
    }
    const expanded = data.replace(
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'RECURRENCE-ID;TZID=America/New_York:20260301T090000',
    );
    expect(
      await normalizeIcs(
        expanded,
        URL + 'e.ics',
        dummy,
        'America/New_York',
        '2026-03-01T00:00:00Z',
        '2026-04-01T00:00:00Z',
      ),
    ).toHaveLength(1);
    const floating = expanded.replaceAll(';TZID=America/New_York', '');
    expect(
      (
        await normalizeIcs(
          floating,
          URL + 'f.ics',
          dummy,
          'America/New_York',
          '2026-03-01T00:00:00Z',
          '2026-04-01T00:00:00Z',
        )
      )[0].startInstant,
    ).toBe('2026-03-01T14:00:00.000Z');
    await expect(
      normalizeIcs(
        data.replaceAll('America/New_York', 'Unknown/Zone'),
        URL + 'x',
        dummy,
        'UTC',
        '2026-03-01T00:00:00Z',
        '2026-04-01T00:00:00Z',
      ),
    ).rejects.toThrow('safely imported');
  });
});

describe('iCloud API on real D1', () => {
  let runtime: ReturnType<typeof createDatabase>, db: D1Database, env: Env, operator: string;
  let records: Map<string, { etag: string; ics: string }>,
    changes: Map<string, string | null>,
    token: number;
  let failure: number, invalidToken: boolean, networkError: boolean;
  let fetchMock: ReturnType<typeof vi.fn>;
  const call = async (
    path: string,
    body?: unknown,
    privileged = true,
    method = body === undefined ? 'GET' : 'POST',
  ) =>
    worker.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          ...(privileged ? { 'X-Reward-Operator': operator } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const connect = () =>
    call('/api/icloud/connect', { account: ACCOUNT, appSpecificPassword: PASSWORD });
  const primary = async () => (await calendars(db))[0];
  const enable = async (
    privacyMode: 'busy' | 'title' | 'full' = 'full',
    memberId: string | null = 'jason',
  ) =>
    configure(env, { sourceId: (await primary()).source_id, enabled: true, privacyMode, memberId });
  const refresh = async () => {
    await db.prepare('UPDATE icloud_calendars SET last_attempt_at=NULL').run();
    return sync(env, true);
  };
  beforeEach(async () => {
    runtime = createDatabase();
    db = (await runtime.getD1Database('DB')) as unknown as D1Database;
    await migrate(db);
    await seed(db);
    await testSession(db);
    env = {
      DB: db,
      ICLOUD_CREDENTIAL_ENCRYPTION_KEY: KEY,
      REWARDS_OPERATOR_PIN: 'test-only-48269173',
    } as Env;
    operator = (
      (await (
        await call('/api/rewards/operator', { pin: env.REWARDS_OPERATOR_PIN }, false)
      ).json()) as { token: string }
    ).token;
    records = new Map([['a.ics', { etag: 'one', ics: sample() }]]);
    changes = new Map();
    token = 1;
    failure = 0;
    invalidToken = false;
    networkError = false;
    fetchMock = vi.fn(async (href: string, init: RequestInit) => {
      expect(init.method === 'PROPFIND' || init.method === 'REPORT').toBe(true);
      expect(init.headers).toMatchObject({
        Authorization: `Basic ${btoa(ACCOUNT + ':' + PASSWORD)}`,
      });
      if (networkError) throw new Error('Sensitive provider exception ' + PASSWORD);
      if (failure) return new Response('Sensitive server ' + PASSWORD, { status: failure });
      const body = String(init.body);
      if (body.includes('current-user-principal'))
        return response(
          multistatus(
            row(
              '/',
              `<d:current-user-principal><d:href>${HOME}principal/</d:href></d:current-user-principal>`,
            ),
          ),
        );
      if (body.includes('calendar-home-set'))
        return response(
          multistatus(
            row('/', `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>`),
          ),
        );
      if (init.method === 'PROPFIND' && body.includes('resourcetype'))
        return response(fixture('discovery.xml'));
      if (init.method === 'PROPFIND')
        return response(multistatus(row(URL, `<d:sync-token>token-${token}</d:sync-token>`)));
      if (body.includes('sync-collection')) {
        if (invalidToken) {
          invalidToken = false;
          return new Response('<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>', {
            status: 403,
          });
        }
        return response(
          multistatus(
            [...changes]
              .map(([href, etag]) =>
                etag === null
                  ? `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
                  : row(href, `<d:getetag>${etag}</d:getetag>`),
              )
              .join(''),
            'token-' + token,
          ),
        );
      }
      if (body.includes('calendar-query'))
        return response(
          multistatus(
            [...records].map(([href, r]) => row(href, `<d:getetag>${r.etag}</d:getetag>`)).join(''),
          ),
        );
      const requested = [...body.matchAll(/<d:href>(.*?)<\/d:href>/g)].map((m) =>
        decodeURIComponent(m[1]).split('/').at(-1)!,
      );
      return response(
        multistatus(
          requested
            .map((href) => {
              const r = records.get(href)!;
              return row(
                href,
                `<d:getetag>${r.etag}</d:getetag><c:calendar-data>${escapeXml(r.ics)}</c:calendar-data>`,
              );
            })
            .join(''),
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await runtime.dispose();
  });
  it('requires household and operator authorization, validates app passwords, encrypts credentials and defaults discovery disabled', async () => {
    for (const [path, method, body] of [
      ['/api/icloud/status', 'GET', undefined],
      ['/api/icloud/connect', 'POST', { account: ACCOUNT, appSpecificPassword: PASSWORD }],
      ['/api/icloud/calendars', 'GET', undefined],
      ['/api/icloud/disconnect', 'POST', {}],
      ['/api/calendar/refresh', 'POST', {}],
    ] as const) {
      const anonymous = await rawWorker.fetch(
        new Request(ORIGIN + path, {
          method,
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env,
      );
      expect(anonymous.status).toBe(401);
      if (path.startsWith('/api/icloud/'))
        expect((await call(path, body, false, method)).status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (
        await call('/api/icloud/connect', {
          account: ACCOUNT,
          appSpecificPassword: 'normal-password',
        })
      ).status,
    ).toBe(400);
    expect((await connect()).status).toBe(200);
    const c = (await connection(db))!;
    expect(c.password_ciphertext).not.toContain(PASSWORD);
    expect(atob(c.password_ciphertext)).not.toContain(PASSWORD);
    const status = await (await call('/api/icloud/status')).text();
    expect(status).not.toMatch(/ciphertext|password_iv|principal_url/);
    expect(status).not.toContain(PASSWORD);
    expect((await calendars(db)).every((c) => !c.enabled)).toBe(true);
    expect((await readState(db)).events.every((e) => !e.id.startsWith('i_'))).toBe(true);
    failure = 401;
    expect((await connect()).status).toBe(401);
    expect(await connection(db)).toEqual(c);
  }, 60000);
  it('imports, changes mappings, enforces read-only APIs and removes sensitive details immediately on privacy changes', async () => {
    await connect();
    await enable();
    expect((await refresh()).synced).toBe(1);
    let state = await readState(db);
    const imported = state.events.find((e) => e.id.startsWith('i_'))!;
    expect(imported).toMatchObject({
      title: 'Sensitive title',
      memberIds: ['jason'],
      location: 'Private location',
      notes: 'Private notes',
    });
    // Adult members map normally, just as children do.
    expect(state.family.find((m) => m.id === 'jason')!.role).toBe('adult');
    const mutation = {
      id: crypto.randomUUID(),
      revision: state.household.revision,
      operations: [{ type: 'delete', entity: 'event', id: imported.id }],
    };
    expect((await call('/api/mutations', mutation)).status).toBe(400);
    await enable('full', 'kelly');
    expect((await readState(db)).events.find((e) => e.id === imported.id)!.memberIds).toEqual([
      'kelly',
    ]);
    await enable('title', null);
    expect((await readState(db)).events.some((e) => e.id === imported.id)).toBe(false);
    await refresh();
    state = await readState(db);
    const title = state.events.find((e) => e.id === imported.id)!;
    expect(title.title).toBe('Sensitive title');
    expect(title.notes).toBeUndefined();
    expect(title.location).toBeUndefined();
    expect(title.memberIds).toEqual([]);
    await enable('busy');
    await refresh();
    expect(
      JSON.stringify((await readState(db)).events.filter((e) => e.id === imported.id)),
    ).not.toMatch(/Sensitive|Private/);
    expect(
      (
        await call(
          '/api/icloud/calendars',
          {
            sourceId: (await primary()).source_id,
            enabled: true,
            privacyMode: 'full',
            memberId: 'unknown',
          },
          true,
          'PATCH',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          '/api/icloud/calendars',
          { sourceId: (await primary()).source_id, enabled: false, privacyMode: 'busy' },
          false,
          'PATCH',
        )
      ).status,
    ).toBe(403);
  }, 60000);
  it('uses sync tokens/ETags for modified, new and deleted resources, prevents duplicates and recovers invalid tokens', async () => {
    await connect();
    await enable();
    await refresh();
    const old = await readState(db);
    const oldEvent = old.events.find((e) => e.id.startsWith('i_'))!;
    records.set('a.ics', { etag: 'two', ics: sample('Updated') });
    records.set('b.ics', { etag: 'new', ics: sample('New').replace('UID:event-one', 'UID:new') });
    changes = new Map([
      ['a.ics', 'two'],
      ['b.ics', 'new'],
    ]);
    token++;
    await refresh();
    expect((await readState(db)).events.filter((e) => e.id.startsWith('i_'))).toHaveLength(2);
    expect((await readState(db)).events.find((e) => e.id === oldEvent.id)!.title).toBe('Updated');
    records.delete('a.ics');
    changes = new Map([['a.ics', null]]);
    token++;
    await refresh();
    expect((await readState(db)).events.filter((e) => e.id.startsWith('i_'))).toHaveLength(1);
    changes = new Map();
    await refresh();
    expect((await readState(db)).events.filter((e) => e.id.startsWith('i_'))).toHaveLength(1);
    invalidToken = true;
    await refresh();
    expect((await readState(db)).events.filter((e) => e.id.startsWith('i_'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some((c) => String(c[1].body).includes('calendar-query'))).toBe(
      true,
    );
  }, 60000);
  it('performs zero writes on normal reads/fresh checks and zero event writes/revision bumps on no-change sync', async () => {
    records = new Map(
      Array.from({ length: 250 }, (_, i) => [
        `${i}.ics`,
        { etag: `version-${i}`, ics: sample().replace('UID:event-one', `UID:many-${i}`) },
      ]),
    );
    await connect();
    await enable();
    await refresh();
    const before = await readState(db);
    changes = new Map();
    // Wrap Miniflare's public interface (its RPC methods cannot be monkeypatched).
    let totalWrites = 0,
      eventWrites = 0;
    const originals = new WeakMap<
      D1PreparedStatement,
      { statement: D1PreparedStatement; sql: string }
    >();
    const record = (result: D1Result, sql: string) => {
      totalWrites += result.meta.rows_written;
      if (
        /^(INSERT INTO events|DELETE FROM events|UPDATE events|INSERT INTO event_members|DELETE FROM event_members)/.test(
          sql,
        )
      )
        eventWrites += result.meta.rows_written;
      return result;
    };
    function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
      const wrapped = {
        bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
        run: async () => record(await statement.run(), sql),
        all: async () => record(await statement.all(), sql),
        first: async (column?: string) => {
          const result = record(await statement.all(), sql);
          if (!result.results.length) return null;
          return column
            ? (result.results[0] as Record<string, unknown>)[column]
            : result.results[0];
        },
        raw: (options?: { columnNames?: boolean }) => statement.raw(options),
      } as D1PreparedStatement;
      originals.set(wrapped, { statement, sql });
      return wrapped;
    }
    env.DB = {
      prepare: (sql: string) => wrap(db.prepare(sql), sql),
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await db.batch(statements.map((s) => originals.get(s)?.statement ?? s));
        results.forEach((r, i) => record(r, originals.get(statements[i])?.sql ?? ''));
        return results;
      },
    } as D1Database;
    shareTestSession(db, env.DB);
    for (let i = 0; i < 3; i++) {
      expect((await call('/api/calendar/refresh', {}, false)).status).toBe(200);
      await call('/api/household', undefined, false);
      await call('/api/icloud/status');
    }
    expect(totalWrites).toBe(0);
    await db.prepare('UPDATE icloud_calendars SET last_attempt_at=NULL').run();
    await sync(env, true);
    expect(eventWrites).toBe(0);
    expect((await readState(db)).household.revision).toBe(before.household.revision);
    expect((await readState(db)).events).toEqual(before.events);
    expect(totalWrites).toBeLessThan(20);
    expect(before.events.filter((e) => e.id.startsWith('i_'))).toHaveLength(250);
    expect(
      fetchMock.mock.calls.filter((c) => String(c[1].body).includes('calendar-multiget')),
    ).toHaveLength(5);
    console.log(
      `iCloud no-change sync: ${totalWrites} rows_written; ${eventWrites} event/member writes for 250 occurrences`,
    );
  }, 60000);
  it('preserves cached data on outages/revocation, blocks repeated revoked retries and reconnects without losing mappings', async () => {
    await connect();
    await enable();
    await refresh();
    const before = await readState(db),
      mapping = (await primary()).member_id;
    networkError = true;
    expect(await refresh()).toMatchObject({
      outcome: 'unavailable',
      diagnostic: { code: 'icloud_network', phase: 'calendar-query' },
    });
    expect((await readState(db)).events).toEqual(before.events);
    expect((await readState(db)).household.revision).toBe(before.household.revision);
    networkError = false;
    failure = 401;
    await refresh();
    expect((await connection(db))!.requires_attention).toBe(1);
    const calls = fetchMock.mock.calls.length;
    await refresh();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    failure = 0;
    expect((await connect()).status).toBe(200);
    expect((await primary()).member_id).toBe(mapping);
    expect((await primary()).enabled).toBe(1);
    expect((await connection(db))!.requires_attention).toBe(0);
    expect((await readState(db)).events).toEqual(before.events);
    expect(
      await (await call('/api/calendar/refresh', { manual: true }, false)).text(),
    ).not.toContain(PASSWORD);
  }, 60000);
  it('uses bounded ETag fallback, preserves cached events on malformed data and disconnects only iCloud-owned data', async () => {
    await connect();
    await enable();
    await db.prepare('UPDATE icloud_calendars SET supports_sync=0').run();
    await refresh();
    const before = await readState(db);
    changes = new Map();
    await refresh();
    expect((await readState(db)).events).toEqual(before.events);
    records.set('a.ics', { etag: 'bad', ics: 'bad calendar' });
    expect(await refresh()).toMatchObject({
      diagnostic: { code: 'icloud_event', phase: 'event-download' },
    });
    await db.prepare('UPDATE icloud_calendars SET last_attempt_at=NULL').run();
    const report = await (await call('/api/calendar/refresh', { manual: true }, false)).text();
    expect(JSON.parse(report)).toMatchObject({
      providers: {
        icloud: {
          outcome: 'unavailable',
          diagnostic: { code: 'icloud_event', phase: 'event-download' },
        },
      },
    });
    for (const privateValue of [PASSWORD, ACCOUNT, 'Private notes', 'Sensitive title', URL])
      expect(report).not.toContain(privateValue);
    expect((await readState(db)).events).toEqual(before.events);
    const source = (await primary()).source_id;
    await db
      .prepare(
        "INSERT INTO calendar_sources(household_id,id,name,provider,color) VALUES ('home','google_keep','Google','google','#4285f4')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO events(household_id,id,sourceId,title,date,allDay,timeZone,recurrence) VALUES ('home','google_event','google_keep','Google plan','2026-10-01',1,'UTC','{\"frequency\":\"none\"}')",
      )
      .run();
    await disconnect(env);
    const after = await readState(db);
    expect(after.events.filter((e) => e.sourceId === source)).toEqual([]);
    expect(after.events.filter((e) => e.sourceId !== 'google_keep')).toEqual(
      before.events.filter((e) => e.sourceId !== source),
    );
    expect(after.events.some((e) => e.id === 'google_event')).toBe(true);
    expect(after.chores).toEqual(before.chores);
    expect(after.family).toEqual(before.family);
    expect(await connection(db)).toBeNull();
    expect((await db.prepare('SELECT * FROM icloud_resources').all()).results).toEqual([]);
  }, 60000);
  it('fences concurrent operations, does not change household isolation and preserves data when a sync response is incomplete', async () => {
    await connect();
    await enable();
    await refresh();
    const before = await readState(db);
    await db.prepare('UPDATE icloud_calendars SET last_attempt_at=NULL').run();
    await withLease(
      db,
      async (lease) => {
        await expect(sync(env, true)).rejects.toThrow('Another calendar operation');
        await db.prepare('UPDATE icloud_operation_locks SET expires_at=0').run();
        await expect(
          commit(lease, [
            db.prepare('DELETE FROM events WHERE sourceId=?').bind((await primary()).source_id),
          ]),
        ).rejects.toThrow('Nothing in this batch');
      },
      'icloud',
    );
    expect((await readState(db)).events).toEqual(before.events);
    await db.batch([
      db.prepare("INSERT INTO households(id,name,timeZone) VALUES ('other','Other','UTC')"),
      db.prepare(
        "INSERT INTO members(household_id,id,name,initial,color,tint,role) VALUES ('other','foreign','Foreign','F','#123456','#ffffff','child')",
      ),
    ]);
    await expect(enable('full', 'foreign')).rejects.toThrow('existing household');
    fetchMock.mockImplementationOnce(async () =>
      response(
        '<d:multistatus xmlns:d="DAV:"><d:response><d:href>a.ics</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response><d:sync-token>changed</d:sync-token></d:multistatus>',
      ),
    );
    await refresh();
    expect((await readState(db)).events).toEqual(before.events);
  }, 60000);
  it('retains empty resource versions, recovers unsupported expansion, handles privacy-safe cancellations and confirmed collection removal', async () => {
    await connect();
    await enable();
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (href: string, init: RequestInit) =>
      String(init.body).includes('<c:expand')
        ? new Response(
            `<d:error xmlns:d="DAV:" xmlns:c="${CAL}"><c:supported-calendar-data/></d:error>`,
            { status: 403 },
          )
        : normal(href, init),
    );
    await refresh();
    const before = await readState(db),
      source = (await primary()).source_id;
    expect(before.events.some((e) => e.sourceId === source)).toBe(true);
    records.set('a.ics', {
      etag: 'cancelled',
      ics: sample().replace(
        'SUMMARY:Sensitive title',
        'STATUS:CANCELLED\r\nSUMMARY:Sensitive title',
      ),
    });
    changes = new Map([['a.ics', 'cancelled']]);
    token++;
    await refresh();
    expect((await readState(db)).events.filter((e) => e.sourceId === source)).toEqual([]);
    await db.prepare('UPDATE icloud_calendars SET supports_sync=0').run();
    const calls = fetchMock.mock.calls.filter((c) =>
      String(c[1].body).includes('calendar-multiget'),
    ).length;
    await refresh();
    expect(
      fetchMock.mock.calls.filter((c) => String(c[1].body).includes('calendar-multiget')),
    ).toHaveLength(calls);
    fetchMock.mockImplementationOnce(async () => response('<d:multistatus xmlns:d="DAV:"/>'));
    const stored = await calendars(db);
    await expect(discover(env)).rejects.toThrow('incomplete');
    expect(await calendars(db)).toEqual(stored);
    failure = 403;
    await refresh();
    expect((await calendars(db)).some((c) => c.source_id === source)).toBe(true);
    failure = 404;
    expect(await refresh()).toEqual({ outcome: 'complete', synced: 1 });
    expect((await calendars(db)).some((c) => c.source_id === source)).toBe(false);
    expect((await readState(db)).events).toEqual(
      before.events.filter((e) => e.sourceId !== source),
    );
  }, 60000);
  it('retries slow expansion once in raw mode, bounds requests and keeps cached data/token if raw download also times out', async () => {
    await connect();
    await enable();
    records = new Map(
      Array.from({ length: 51 }, (_, i) => [
        `event-${i}.ics`,
        { etag: 'initial', ics: sample().replace('UID:event-one', `UID:event-${i}`) },
      ]),
    );
    const normal = fetchMock.getMockImplementation()!;
    let failRaw = false,
      transportError = false;
    fetchMock.mockImplementation(async (href: string, init: RequestInit) => {
      const body = String(init.body);
      if (
        body.includes('<c:expand') ||
        (failRaw && (body.includes('calendar-multiget') || init.method === 'GET'))
      ) {
        if (transportError) throw new TypeError('Private upstream detail ' + PASSWORD);
        throw new DOMException('Private upstream detail ' + PASSWORD, 'TimeoutError');
      }
      return normal(href, init);
    });
    env.calendarHttpBudget = { remaining: 40 };
    expect(await refresh()).toEqual({ outcome: 'complete', synced: 1 });
    const downloads = fetchMock.mock.calls.filter((c) =>
      String(c[1].body).includes('calendar-multiget'),
    );
    expect(downloads).toHaveLength(3);
    expect(downloads.filter((c) => String(c[1].body).includes('<c:expand'))).toHaveLength(1);
    expect(env.calendarHttpBudget.remaining).toBeGreaterThan(0);
    const before = await readState(db),
      stored = await primary();
    expect(before.events.filter((e) => e.sourceId === stored.source_id)).toHaveLength(51);
    failRaw = true;
    changes = new Map([['event-0.ics', 'changed']]);
    token++;
    records.set('event-0.ics', { etag: 'changed', ics: sample('Changed private event') });
    env.calendarHttpBudget = { remaining: 40 };
    const result = await refresh();
    expect(result).toMatchObject({
      outcome: 'unavailable',
      diagnostic: { code: 'icloud_timeout', phase: 'event-read' },
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect((await primary()).sync_token).toBe(stored.sync_token);
    expect((await readState(db)).events).toEqual(before.events);
    expect((await readState(db)).household.revision).toBe(before.household.revision);
    failRaw = false;
    transportError = true;
    env.calendarHttpBudget = { remaining: 40 };
    expect(await refresh()).toEqual({ outcome: 'complete', synced: 1 });
    expect((await readState(db)).events.some((e) => e.title === 'Changed private event')).toBe(
      true,
    );
    expect((await primary()).sync_token).not.toBe(stored.sync_token);
  }, 60000);
  it('omits multiget Depth and shrinks slow raw batches without partial commits or unbounded retries', async () => {
    await connect();
    await enable();
    records = new Map(
      Array.from({ length: 51 }, (_, i) => [
        `event-${i}.ics`,
        { etag: 'initial', ics: sample().replace('UID:event-one', `UID:event-${i}`) },
      ]),
    );
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (href: string, init: RequestInit) => {
      const body = String(init.body);
      if (body.includes('calendar-multiget')) {
        expect(new Headers(init.headers).has('Depth')).toBe(false);
        if (body.includes('<c:expand') || [...body.matchAll(/<d:href>/g)].length > 10)
          throw new DOMException('Private upstream detail ' + PASSWORD, 'TimeoutError');
      }
      return normal(href, init);
    });
    env.calendarHttpBudget = { remaining: 40 };
    expect(await refresh()).toEqual({ outcome: 'complete', synced: 1 });
    const source = (await primary()).source_id;
    const before = await readState(db),
      stored = await primary();
    expect(before.events.filter((e) => e.sourceId === source)).toHaveLength(51);
    const downloads = fetchMock.mock.calls.filter((c) =>
      String(c[1].body).includes('calendar-multiget'),
    );
    expect(downloads).toHaveLength(8);
    expect(
      downloads.slice(2).every((c) => [...String(c[1].body).matchAll(/<d:href>/g)].length <= 10),
    ).toBe(true);
    expect(env.calendarHttpBudget.remaining).toBeGreaterThan(0);
    // A tight shared budget must terminate rather than commit a partial batch.
    records.set('event-0.ics', { etag: 'changed', ics: sample('Changed private event') });
    records.set('event-1.ics', { etag: 'changed', ics: sample('Another changed event') });
    changes = new Map([
      ['event-0.ics', 'changed'],
      ['event-1.ics', 'changed'],
    ]);
    token++;
    env.calendarHttpBudget = { remaining: 2 };
    expect(await refresh()).toMatchObject({
      outcome: 'unavailable',
      diagnostic: { code: 'calendar_limit' },
    });
    expect((await primary()).sync_token).toBe(stored.sync_token);
    expect((await readState(db)).events).toEqual(before.events);
    expect((await readState(db)).household.revision).toBe(before.household.revision);
  }, 60000);
  it('falls back to individual event reads when even small multiget requests time out and preserves every cached projection on a missing resource', async () => {
    await connect();
    await enable('title', 'kelly');
    records.set('b.ics', {
      etag: 'one',
      ics: sample('Second event').replace('UID:event-one', 'UID:second'),
    });
    const normal = fetchMock.getMockImplementation()!;
    let missing = false;
    fetchMock.mockImplementation(async (href: string, init: RequestInit) => {
      if (init.method === 'GET') {
        const name = new globalThis.URL(href).pathname.split('/').at(-1)!;
        if (missing && name === 'b.ics')
          return new Response('Private provider details', { status: 404 });
        const record = records.get(name)!;
        return new Response(record.ics, { headers: { ETag: record.etag } });
      }
      if (String(init.body).includes('calendar-multiget'))
        throw new DOMException(PASSWORD, 'TimeoutError');
      return normal(href, init);
    });
    env.calendarHttpBudget = { remaining: 40 };
    expect(await refresh()).toEqual({ outcome: 'complete', synced: 1 });
    const before = await readState(db),
      stored = await primary();
    const imported = before.events.filter((e) => e.sourceId === stored.source_id);
    expect(imported).toHaveLength(2);
    expect(imported.every((e) => e.memberIds[0] === 'kelly' && !e.notes && !e.location)).toBe(true);
    expect(fetchMock.mock.calls.filter((c) => c[1].method === 'GET')).toHaveLength(2);
    missing = true;
    records.set('a.ics', { etag: 'two', ics: sample('Changed event') });
    changes = new Map([
      ['a.ics', 'two'],
      ['b.ics', 'two'],
    ]);
    token++;
    env.calendarHttpBudget = { remaining: 40 };
    expect(await refresh()).toMatchObject({
      outcome: 'unavailable',
      diagnostic: { phase: 'event-read', httpStatus: 404 },
    });
    expect((await primary()).sync_token).toBe(stored.sync_token);
    expect((await calendars(db)).some((c) => c.source_id === stored.source_id)).toBe(true);
    expect((await readState(db)).events).toEqual(before.events);
    expect((await readState(db)).household.revision).toBe(before.household.revision);
  }, 60000);
  it('preserves calendar configuration on same-account shard moves and renews the bounded window without retroactively importing history', async () => {
    await connect();
    await enable('title', 'kelly');
    await refresh();
    const before = await readState(db),
      old = await primary();
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (href: string, init: RequestInit) => {
      const r = await normal(href, init);
      return response(
        (await r.text()).replaceAll(
          '<X:href>family/</X:href>',
          `<X:href>${URL.replace('p01-', 'p02-')}</X:href>`,
        ),
      );
    });
    expect((await connect()).status).toBe(200);
    const moved = await primary();
    expect(moved.source_id).toBe(old.source_id);
    expect(moved.url).toContain('p02-');
    expect(moved).toMatchObject({
      enabled: 1,
      privacy_mode: 'title',
      member_id: 'kelly',
      sync_token: null,
      full_synced_at: null,
    });
    expect((await readState(db)).events).toEqual(before.events);
    await refresh();
    expect((await readState(db)).events.filter((e) => e.sourceId === old.source_id)).toHaveLength(
      1,
    );
    await db
      .prepare(
        "UPDATE icloud_calendars SET full_synced_at='2000-01-01T00:00:00Z',window_start='1900-01-01T00:00:00Z'",
      )
      .run();
    await refresh();
    expect(Date.parse((await primary()).window_start!)).toBeGreaterThan(Date.now() - 31 * 86400000);
  }, 60000);
  it('adds migration 0008 without changing any prior household/provider/auth table', async () => {
    const legacyRuntime = createDatabase();
    try {
      const legacy = (await legacyRuntime.getD1Database('DB')) as unknown as D1Database;
      await migrate(legacy, '0007_member_roles.sql');
      await seed(legacy);
      const secret = await encryptSecret('fixture-google-refresh', KEY, 'legacy');
      await legacy
        .prepare(
          "INSERT INTO google_connections(household_id,id,refresh_ciphertext,refresh_iv,encryption_version,scopes) VALUES ('home','legacy',?,?,1,'existing-readonly-scopes')",
        )
        .bind(secret.ciphertext, secret.iv)
        .run();
      const names = (
        await legacy
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name",
          )
          .all<{ name: string }>()
      ).results.map((r) => r.name);
      const before = await Promise.all(
        names.map(async (name) => (await legacy.prepare(`SELECT * FROM ${name}`).all()).results),
      );
      await applyMigration(legacy, '0008_icloud_calendar.sql');
      for (const [i, name] of names.entries())
        expect((await legacy.prepare(`SELECT * FROM ${name}`).all()).results).toEqual(before[i]);
      expect(await connection(legacy)).toBeNull();
      expect(await calendars(legacy)).toEqual([]);
      expect((await readState(legacy)).events).toHaveLength((await readState(db)).events.length);
    } finally {
      await legacyRuntime.dispose();
    }
  }, 60000);
});
