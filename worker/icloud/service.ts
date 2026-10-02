import { z } from 'zod';
import { ApiError, HOUSEHOLD_ID } from '../database';
import { withLease, commit, type Lease } from '../calendar/lease';
import { assignImportedEvents, projectionChanges } from '../calendar/projection';
import { encryptionKey, encryptSecret, decryptSecret } from '../calendar/credentials';
import { hash } from '../google/crypto';
import { calendarSettings } from '../calendar/settings';
import { icloudDiagnostic, type SyncDiagnostic, type SyncPhase } from '../calendar/diagnostics';
import {
  STALE_MS,
  RETRY_MS,
  MANUAL_RETRY_MS,
  projectionWindow,
  WINDOW_RENEW_MS,
} from '../calendar/policy';
import {
  CAL,
  client,
  discovery,
  listCalendars,
  propfind,
  responses,
  value,
  escapeXml,
  resourceUrl,
  safeUrl,
  DavError,
  type DavClient,
} from './dav';
import { normalizeIcs } from './normalize';
import type { Calendar, Connection, Resource } from './types';
import type { CalendarEvent } from '../../src/types';
import type { GoogleSecrets } from '../google/types';
export const keyFor = (env: Env) =>
  env.ICLOUD_CREDENTIAL_ENCRYPTION_KEY || (env as Env & GoogleSecrets).GOOGLE_TOKEN_ENCRYPTION_KEY;
export const connection = (db: D1Database) =>
  db
    .prepare('SELECT * FROM icloud_connections WHERE household_id=?')
    .bind(HOUSEHOLD_ID)
    .first<Connection>();
export const calendars = async (db: D1Database) =>
  (
    await db
      .prepare(
        'SELECT c.*,m.member_id FROM icloud_calendars c LEFT JOIN external_calendar_members m ON m.household_id=c.household_id AND m.source_id=c.source_id WHERE c.household_id=? ORDER BY c.name,c.source_id',
      )
      .bind(HOUSEHOLD_ID)
      .all<Calendar>()
  ).results;
export const safeCalendar = (c: Calendar) => ({
  sourceId: c.source_id,
  name: c.name,
  color: c.color,
  enabled: !!c.enabled,
  privacyMode: c.privacy_mode,
  memberId: c.member_id ?? null,
  lastSyncedAt: c.last_synced_at,
  lastFailure: c.last_sync_error,
});
const secretPurpose = 'icloud-app-password';
async function authenticatedClient(env: Env, c: Connection) {
  return client(
    c.account,
    await decryptSecret(
      c.password_ciphertext,
      c.password_iv,
      c.encryption_version,
      keyFor(env),
      c.id,
      secretPurpose,
      'icloud',
    ),
    env.calendarHttpBudget,
  );
}
export const connectSchema = z
  .object({
    account: z
      .email()
      .trim()
      .max(254)
      .transform((v) => v.toLowerCase()),
    appSpecificPassword: z
      .string()
      .regex(
        /^[a-z]{4}(?:-[a-z]{4}){3}$/i,
        'Enter an Apple app-specific password (xxxx-xxxx-xxxx-xxxx).',
      ),
  })
  .strict();
async function discoveredStatements(
  lease: Lease,
  id: string,
  found: Awaited<ReturnType<typeof listCalendars>>,
) {
  const db = lease.db,
    old = await calendars(db),
    statements: D1PreparedStatement[] = [];
  for (const item of found) {
    const sourceId = `icloud_${await hash(JSON.stringify([id, new URL(item.url).pathname]))}`,
      prior = old.find((c) => c.source_id === sourceId);
    const sourceName = prior?.privacy_mode !== 'busy' && prior ? item.name : 'iCloud calendar';
    if (
      !prior ||
      prior.url !== item.url ||
      prior.name !== item.name ||
      prior.color !== item.color ||
      !!prior.supports_sync !== item.supportsSync
    ) {
      statements.push(
        db
          .prepare(
            "INSERT INTO calendar_sources(household_id,id,name,provider,color) VALUES (?,?,?,'icloud',?) ON CONFLICT(household_id,id) DO UPDATE SET name=excluded.name,color=excluded.color WHERE calendar_sources.provider='icloud'",
          )
          .bind(HOUSEHOLD_ID, sourceId, sourceName, item.color),
        db
          .prepare(
            'INSERT INTO icloud_calendars(household_id,url,source_id,name,color,supports_sync) VALUES (?,?,?,?,?,?) ON CONFLICT(household_id,source_id) DO UPDATE SET url=excluded.url,name=excluded.name,color=excluded.color,supports_sync=excluded.supports_sync',
          )
          .bind(HOUSEHOLD_ID, item.url, sourceId, item.name, item.color, Number(item.supportsSync)),
      );
    }
    if (prior && prior.url !== item.url)
      statements.push(
        db
          .prepare('DELETE FROM icloud_resources WHERE household_id=? AND source_id=?')
          .bind(HOUSEHOLD_ID, sourceId),
        db
          .prepare(
            'UPDATE icloud_calendars SET sync_token=NULL,full_synced_at=NULL,last_attempt_at=NULL WHERE household_id=? AND source_id=?',
          )
          .bind(HOUSEHOLD_ID, sourceId),
      );
  }
  for (const c of old.filter(
    (c) => !found.some((f) => new URL(f.url).pathname === new URL(c.url).pathname),
  ))
    statements.push(...removeCalendar(db, c));
  return statements;
}
function removeCalendar(db: D1Database, c: Calendar) {
  return [
    db
      .prepare('DELETE FROM events WHERE household_id=? AND sourceId=?')
      .bind(HOUSEHOLD_ID, c.source_id),
    db
      .prepare('DELETE FROM icloud_calendars WHERE household_id=? AND source_id=?')
      .bind(HOUSEHOLD_ID, c.source_id),
    db
      .prepare("DELETE FROM calendar_sources WHERE household_id=? AND id=? AND provider='icloud'")
      .bind(HOUSEHOLD_ID, c.source_id),
  ];
}
export async function connect(env: Env, input: z.infer<typeof connectSchema>) {
  await encryptionKey(keyFor(env), 'icloud');
  return withLease(
    env.DB,
    async (lease) => {
      const old = await connection(env.DB);
      if (old && old.account !== input.account)
        throw new ApiError(
          409,
          'Disconnect this iCloud account before connecting another.',
          'icloud_account',
        );
      const found = await discovery(
        client(input.account, input.appSpecificPassword, env.calendarHttpBudget),
      );
      const id = old?.id ?? crypto.randomUUID();
      const encrypted = await encryptSecret(
        input.appSpecificPassword,
        keyFor(env),
        id,
        secretPurpose,
        'icloud',
      );
      const statements = await discoveredStatements(lease, id, found.calendars);
      statements.unshift(
        env.DB.prepare(
          'INSERT INTO icloud_connections(household_id,id,account,password_ciphertext,password_iv,encryption_version,principal_url,home_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(household_id) DO UPDATE SET password_ciphertext=excluded.password_ciphertext,password_iv=excluded.password_iv,encryption_version=excluded.encryption_version,principal_url=excluded.principal_url,home_url=excluded.home_url,requires_attention=0',
        ).bind(
          HOUSEHOLD_ID,
          id,
          input.account,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.version,
          found.principalUrl,
          found.homeUrl,
        ),
      );
      statements.push(
        env.DB.prepare(
          'UPDATE icloud_calendars SET last_attempt_at=NULL,last_sync_error=NULL WHERE household_id=? AND (last_attempt_at IS NOT NULL OR last_sync_error IS NOT NULL)',
        ).bind(HOUSEHOLD_ID),
      );
      await commit(lease, statements, statements.length > 2);
      return { connected: true, calendars: (await calendars(env.DB)).map(safeCalendar) };
    },
    'icloud',
  );
}
export async function discover(env: Env) {
  return withLease(
    env.DB,
    async (lease) => {
      const c = await connection(env.DB);
      if (!c) throw new ApiError(409, 'Connect iCloud first.', 'icloud_not_connected');
      const statements = await discoveredStatements(
        lease,
        c.id,
        await listCalendars(await authenticatedClient(env, c), c.home_url),
      );
      if (statements.length) await commit(lease, statements);
      return (await calendars(env.DB)).map(safeCalendar);
    },
    'icloud',
  );
}
export async function configure(env: Env, settings: z.infer<typeof calendarSettings>) {
  return withLease(
    env.DB,
    async (lease) => {
      const c = (await calendars(env.DB)).find((c) => c.source_id === settings.sourceId);
      if (!c) throw new ApiError(404, 'Discover this iCloud calendar first.', 'icloud_calendar');
      const memberId = settings.memberId === undefined ? c.member_id : settings.memberId;
      if (
        memberId &&
        !(await env.DB.prepare('SELECT id FROM members WHERE household_id=? AND id=?')
          .bind(HOUSEHOLD_ID, memberId)
          .first())
      )
        throw new ApiError(400, 'Choose an existing household member.', 'icloud_member');
      const projectionChanged =
          !!c.enabled !== settings.enabled || c.privacy_mode !== settings.privacyMode,
        memberChanged = (memberId ?? null) !== (c.member_id ?? null);
      if (!projectionChanged && !memberChanged) return safeCalendar(c);
      const statements: D1PreparedStatement[] = [];
      if (projectionChanged)
        statements.push(
          // Clear old sensitive projections immediately, including during provider outages.
          env.DB.prepare('DELETE FROM events WHERE household_id=? AND sourceId=?').bind(
            HOUSEHOLD_ID,
            c.source_id,
          ),
          env.DB.prepare('DELETE FROM icloud_resources WHERE household_id=? AND source_id=?').bind(
            HOUSEHOLD_ID,
            c.source_id,
          ),
          env.DB.prepare(
            'UPDATE icloud_calendars SET enabled=?,privacy_mode=?,sync_token=NULL,last_synced_at=NULL,full_synced_at=NULL,last_attempt_at=NULL,last_sync_error=NULL WHERE household_id=? AND source_id=?',
          ).bind(Number(settings.enabled), settings.privacyMode, HOUSEHOLD_ID, c.source_id),
          env.DB.prepare(
            "UPDATE calendar_sources SET name=? WHERE household_id=? AND id=? AND provider='icloud' AND name IS NOT ?",
          ).bind(
            settings.privacyMode === 'busy' ? 'iCloud calendar' : c.name,
            HOUSEHOLD_ID,
            c.source_id,
            settings.privacyMode === 'busy' ? 'iCloud calendar' : c.name,
          ),
        );
      if (memberChanged)
        statements.push(
          memberId
            ? env.DB.prepare(
                'INSERT INTO external_calendar_members(household_id,source_id,member_id) VALUES (?,?,?) ON CONFLICT(household_id,source_id) DO UPDATE SET member_id=excluded.member_id',
              ).bind(HOUSEHOLD_ID, c.source_id, memberId)
            : env.DB.prepare(
                'DELETE FROM external_calendar_members WHERE household_id=? AND source_id=?',
              ).bind(HOUSEHOLD_ID, c.source_id),
          ...assignImportedEvents(env.DB, c.source_id, memberId ?? null),
        );
      await commit(lease, statements);
      return safeCalendar(
        (await calendars(env.DB)).find((c) => c.source_id === settings.sourceId)!,
      );
    },
    'icloud',
  );
}
export async function disconnect(env: Env) {
  return withLease(
    env.DB,
    async (lease) => {
      const old = await calendars(env.DB),
        c = await connection(env.DB);
      if (!c) return;
      await commit(lease, [
        ...old.flatMap((c) => removeCalendar(env.DB, c)),
        env.DB.prepare('DELETE FROM icloud_connections WHERE household_id=?').bind(HOUSEHOLD_ID),
      ]);
    },
    'icloud',
  );
}
const due = (c: Calendar, manual: boolean) =>
  (manual || !c.last_synced_at || Date.now() - Date.parse(c.last_synced_at) >= STALE_MS) &&
  (!c.last_attempt_at ||
    Date.now() - Date.parse(c.last_attempt_at) >= (manual ? MANUAL_RETRY_MS : RETRY_MS));
export async function status(db: D1Database) {
  const c = await connection(db),
    enabled = (await calendars(db)).filter((c) => c.enabled),
    lock = await db
      .prepare('SELECT expires_at FROM icloud_operation_locks WHERE household_id=?')
      .bind(HOUSEHOLD_ID)
      .first<{ expires_at: number }>();
  return {
    connected: !!c,
    enabledCalendars: enabled.length,
    stale: enabled.some(
      (c) => !c.last_synced_at || Date.now() - Date.parse(c.last_synced_at) >= STALE_MS,
    ),
    lastSyncedAt:
      enabled.length && enabled.every((c) => c.last_synced_at)
        ? enabled.map((c) => c.last_synced_at!).sort()[0]
        : null,
    syncing: !!lock && lock.expires_at > Date.now(),
    needsAttention: !!c?.requires_attention || enabled.some((c) => c.last_sync_error),
    requiresReconnect: !!c?.requires_attention,
  };
}
const stamp = (date: string) =>
  date
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}/, '');
const envelope = (body: string) =>
  `<c:calendar-query xmlns:d="DAV:" xmlns:c="${CAL}">${body}</c:calendar-query>`;
async function fullInventory(get: DavClient, c: Calendar, from: string, to: string) {
  // Capture the token BEFORE the bounded snapshot so racing provider changes are replayed next time.
  const meta = await get(c.url, 'PROPFIND', propfind('<d:sync-token/>'));
  const token = c.supports_sync
    ? responses(meta.root)
        .map((r) => value(r.props, 'sync-token'))
        .find(Boolean)
    : undefined;
  const report = await get(
    c.url,
    'REPORT',
    envelope(
      `<d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter>`,
    ),
    '1',
  );
  return { rows: responses(report.root), token: token ?? null, full: true };
}
async function inventory(get: DavClient, c: Calendar, from: string, to: string, full: boolean) {
  if (!full && c.supports_sync && c.sync_token) {
    try {
      const { root } = await get(
        c.url,
        'REPORT',
        `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${escapeXml(c.sync_token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
        '1',
      );
      const token = value(root, 'sync-token');
      if (!token)
        throw new ApiError(
          502,
          'iCloud omitted its sync token. Saved events are unchanged.',
          'icloud_response',
        );
      return { rows: responses(root), token, full: false };
    } catch (e) {
      if (!(e instanceof DavError) || !(e.invalidToken || [405, 501].includes(e.davStatus)))
        throw e;
    }
  }
  return fullInventory(get, c, from, to);
}
async function importResources(
  get: DavClient,
  c: Calendar,
  hrefs: string[],
  zone: string,
  from: string,
  to: string,
  onPhase: (phase: SyncPhase) => void,
) {
  const data = new Map<string, { etag: string; events: CalendarEvent[] }>();
  let expand = true;
  let batchSize = 50;
  let individual = false;
  let directReads = true;
  const body = (resources: string[], expand: boolean) =>
    `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="${CAL}"><d:prop><d:getetag/><c:calendar-data>${expand ? `<c:expand start="${stamp(from)}" end="${stamp(to)}"/>` : ''}</c:calendar-data></d:prop>${resources.map((h) => `<d:href>${escapeXml(new URL(h).pathname)}</d:href>`).join('')}</c:calendar-multiget>`;
  async function readIndividual(href: string) {
    if (directReads) {
      try {
        return await get.resource(href, c.url);
      } catch (error) {
        if (
          !(error instanceof DavError) ||
          !error.resourceRequest ||
          ![400, 405, 501].includes(error.davStatus)
        )
          throw error;
        // Some Apple calendars reject direct GET. Learn this once per invocation,
        // then use a single-resource REPORT under the same deadline/request budget.
        directReads = false;
      }
    }
    onPhase('event-report');
    const result = await get(c.url, 'REPORT', body([href], false), null);
    const rows = responses(result.root);
    if (rows.length !== 1 || resourceUrl(rows[0].href, c.url) !== href || rows[0].status !== 200)
      throw new ApiError(
        502,
        'iCloud individual event retrieval was incomplete. Saved events are unchanged.',
        'icloud_response',
      );
    const etag = value(rows[0].props, 'getetag'),
      ics = value(rows[0].props, 'calendar-data', CAL);
    if (!etag || !ics)
      throw new ApiError(
        502,
        'iCloud omitted individual event data. Saved events are unchanged.',
        'icloud_response',
      );
    return { etag, ics };
  }
  const transportFailure = (e: unknown) =>
    e instanceof ApiError && ['icloud_timeout', 'icloud_network'].includes(e.code);
  for (let i = 0; i < hrefs.length;) {
    const chunk = hrefs.slice(i, i + batchSize);
    let result;
    if (individual) {
      onPhase('event-read');
      for (const href of chunk) {
        const { etag, ics } = await readIndividual(href);
        data.set(href, { etag, events: await normalizeIcs(ics, href, c, zone, from, to) });
      }
      i += chunk.length;
      continue;
    }
    try {
      // RFC 4791 section 7.9: multiget should omit Depth.
      result = await get(c.url, 'REPORT', body(chunk, expand), null);
    } catch (e) {
      const retryRaw =
        expand &&
        ((e instanceof DavError && (e.unsupportedExpansion || [400, 501].includes(e.davStatus))) ||
          transportFailure(e));
      if (!retryRaw) {
        if (!expand && transportFailure(e)) {
          if (chunk.length > 10) batchSize = 10;
          else individual = true;
          continue;
        }
        throw e;
      }
      // Failed server-side recurrence expansion gets one bounded raw-data retry.
      // Keep raw mode for the remaining chunks so each batch cannot repeat the
      // same expensive timeout. Normalization and commit remain all-or-nothing.
      expand = false;
      try {
        result = await get(c.url, 'REPORT', body(chunk, false), null);
      } catch (rawError) {
        if (!transportFailure(rawError)) throw rawError;
        // Retry the same resources in smaller batches; the shared client still
        // enforces the original 40-request and 90-second bounds.
        if (chunk.length > 10) batchSize = 10;
        else individual = true;
        continue;
      }
    }
    for (const r of responses(result.root)) {
      const href = resourceUrl(r.href, c.url);
      if (!chunk.includes(href) || data.has(href) || r.status !== 200)
        throw new ApiError(
          502,
          'iCloud resource retrieval was incomplete. Retry synchronization.',
          'icloud_response',
        );
      const etag = value(r.props, 'getetag'),
        ics = value(r.props, 'calendar-data', CAL);
      if (!etag || !ics)
        throw new ApiError(
          502,
          'iCloud omitted event data. Saved events are unchanged.',
          'icloud_response',
        );
      data.set(href, { etag, events: await normalizeIcs(ics, href, c, zone, from, to) });
    }
    if (chunk.some((h) => !data.has(h)))
      throw new ApiError(
        502,
        'iCloud omitted a requested event. Saved events are unchanged.',
        'icloud_response',
      );
    i += chunk.length;
  }
  return data;
}
export async function sync(env: Env, manual = false) {
  const select = async () => {
    const c = await connection(env.DB);
    if (!c || c.requires_attention) return [];
    return (await calendars(env.DB)).filter((c) => c.enabled && due(c, manual));
  };
  if (!(await select()).length) {
    const c = await connection(env.DB);
    const cooling =
      manual && c && !c.requires_attention && (await calendars(env.DB)).some((c) => c.enabled);
    return { outcome: cooling ? 'cooldown' : 'complete', synced: 0 };
  } // No lease/write on fresh or disconnected reads.
  return withLease(
    env.DB,
    async (lease) => {
      const c = await connection(env.DB),
        selected = await select();
      let synced = 0,
        failed = false;
      let diagnostic: SyncDiagnostic | undefined;
      if (!c || !selected.length) return { outcome: 'complete', synced: 0 };
      const get = await authenticatedClient(env, c),
        zone = (await env.DB.prepare('SELECT timeZone FROM households WHERE id=?')
          .bind(HOUSEHOLD_ID)
          .first<{ timeZone: string }>())!.timeZone;
      for (const calendar of selected) {
        let phase: SyncPhase = 'calendar-query';
        const now = new Date().toISOString();
        await commit(
          lease,
          [
            env.DB.prepare(
              'UPDATE icloud_calendars SET last_attempt_at=? WHERE household_id=? AND source_id=?',
            ).bind(now, HOUSEHOLD_ID, calendar.source_id),
          ],
          false,
        );
        try {
          const reset =
            !calendar.full_synced_at ||
            Date.now() - Date.parse(calendar.full_synced_at) > WINDOW_RENEW_MS ||
            calendar.sync_time_zone !== zone;
          const from = reset ? projectionWindow().from : calendar.window_start!,
            to = reset ? projectionWindow().to : calendar.window_end!;
          const old = (
            await env.DB.prepare(
              'SELECT href,etag,event_ids FROM icloud_resources WHERE household_id=? AND source_id=?',
            )
              .bind(HOUSEHOLD_ID, calendar.source_id)
              .all<Resource>()
          ).results;
          const report = await inventory(get, calendar, from, to, reset || !calendar.sync_token);
          const found = new Map<string, string>(),
            deleted = new Set<string>();
          if (report.rows.length > 1000)
            throw new ApiError(
              502,
              'This iCloud calendar exceeds the sync resource limit. Saved events are unchanged.',
              'icloud_limit',
            );
          for (const r of report.rows) {
            const address = new URL(safeUrl(r.href, calendar.url));
            const base = new URL(calendar.url);
            // DAV sync/query responses may describe the collection itself.
            // It is metadata, never an event file to download.
            if (
              address.origin === base.origin &&
              address.pathname.replace(/\/$/, '') === base.pathname.replace(/\/$/, '')
            ) {
              if (r.status === 200) continue;
              if (r.status === 404) throw new DavError(404);
              throw new ApiError(
                502,
                'iCloud calendar metadata could not be read. Saved events are unchanged.',
                'icloud_response',
              );
            }
            const href = resourceUrl(r.href, calendar.url);
            if (r.status === 404) {
              deleted.add(href);
              continue;
            }
            const etag = value(r.props, 'getetag');
            if (r.status !== 200 || !etag)
              throw new ApiError(
                502,
                'iCloud returned incomplete event versions.',
                'icloud_response',
              );
            if (found.has(href))
              throw new ApiError(
                502,
                'iCloud returned duplicate resource addresses.',
                'icloud_response',
              );
            found.set(href, etag);
          }
          if (report.full) for (const r of old) if (!found.has(r.href)) deleted.add(r.href);
          const changed = [...found.keys()].filter(
            (href) => reset || old.find((r) => r.href === href)?.etag !== found.get(href),
          );
          phase = 'event-download';
          const data = await importResources(get, calendar, changed, zone, from, to, (step) => {
              phase = step;
            }),
            imported = [...data.values()].flatMap((d) => d.events);
          if (imported.length > 10000)
            throw new ApiError(
              502,
              'This iCloud calendar exceeds the occurrence limit.',
              'icloud_limit',
            );
          const removed = old
            .filter((r) => deleted.has(r.href) || data.has(r.href))
            .flatMap((r) => JSON.parse(r.event_ids) as string[])
            .filter((id) => !imported.some((e) => e.id === id));
          phase = 'database';
          const delta = await projectionChanges(env.DB, calendar, imported, removed, reset);
          const statements = delta.statements;
          const resourceDeletes = new Set(
            [...deleted].filter((href) => old.some((r) => r.href === href)),
          );
          const resourceUpdates: { href: string; etag: string; event_ids: string }[] = [];
          for (const [href, d] of data) {
            const prior = old.find((r) => r.href === href),
              ids = JSON.stringify(d.events.map((e) => e.id).sort());
            // Remember empty versions returned by the bounded inventory (e.g. cancelled
            // series). Do not cache unlimited out-of-window resources from token deltas.
            if (!d.events.length && !prior && !report.full) continue;
            if (!prior || prior.etag !== d.etag || prior.event_ids !== ids)
              resourceUpdates.push({ href, etag: d.etag, event_ids: ids });
          }
          if (resourceDeletes.size)
            statements.push(
              env.DB.prepare(
                'DELETE FROM icloud_resources WHERE household_id=? AND source_id=? AND href IN (SELECT value FROM json_each(?))',
              ).bind(HOUSEHOLD_ID, calendar.source_id, JSON.stringify([...resourceDeletes])),
            );
          for (let i = 0; i < resourceUpdates.length; i += 100)
            statements.push(
              env.DB.prepare(
                "INSERT INTO icloud_resources(household_id,source_id,href,etag,event_ids) SELECT ?,?,json_extract(value,'$.href'),json_extract(value,'$.etag'),json_extract(value,'$.event_ids') FROM json_each(?) WHERE true ON CONFLICT(household_id,source_id,href) DO UPDATE SET etag=excluded.etag,event_ids=excluded.event_ids",
              ).bind(
                HOUSEHOLD_ID,
                calendar.source_id,
                JSON.stringify(resourceUpdates.slice(i, i + 100)),
              ),
            );
          statements.push(
            env.DB.prepare(
              'UPDATE icloud_calendars SET sync_token=?,window_start=?,window_end=?,sync_time_zone=?,full_synced_at=?,last_synced_at=?,last_sync_error=NULL WHERE household_id=? AND source_id=?',
            ).bind(
              report.token,
              from,
              to,
              zone,
              reset ? now : calendar.full_synced_at,
              now,
              HOUSEHOLD_ID,
              calendar.source_id,
            ),
          );
          await commit(lease, statements, delta.visibleChanged);
          synced++;
        } catch (e) {
          if (e instanceof DavError && e.davStatus === 404 && !e.resourceRequest) {
            await commit(lease, removeCalendar(env.DB, calendar));
            // This is a successful reconciliation: notify the client to reload
            // even when no other calendar imported new occurrences.
            synced++;
            continue;
          } // Confirmed collection removal only.
          failed = true;
          diagnostic ??= icloudDiagnostic(e, phase);
          const authorization = e instanceof ApiError && e.code === 'icloud_authorization',
            failure = authorization
              ? 'authorization'
              : e instanceof ApiError &&
                  ['icloud_credentials', 'icloud_configuration'].includes(e.code)
                ? 'configuration'
                : 'unavailable';
          const statements = [
            env.DB.prepare(
              'UPDATE icloud_calendars SET last_sync_error=? WHERE household_id=? AND source_id=? AND last_sync_error IS NOT ?',
            ).bind(failure, HOUSEHOLD_ID, calendar.source_id, failure),
          ];
          if (authorization)
            statements.push(
              env.DB.prepare(
                'UPDATE icloud_connections SET requires_attention=1 WHERE household_id=? AND requires_attention=0',
              ).bind(HOUSEHOLD_ID),
            );
          await commit(lease, statements, false);
          if (authorization) break;
        }
      }
      return {
        outcome: failed ? 'unavailable' : 'complete',
        synced,
        ...(diagnostic ? { diagnostic } : {}),
      };
    },
    'icloud',
  );
}
