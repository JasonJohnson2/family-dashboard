# Google Calendar: Phase 1

This is a server-side, read-only integration for one Google account in the existing household. No Google events are created, edited, or deleted. The existing React calendar displays normalized imports alongside local plans. Google imports cannot be edited through `/api/mutations`; local event editing continues unchanged. Polished connection management, multiple Google accounts, scheduled synchronization, and push notifications are future work.

## Google Cloud configuration

Enable the Google Calendar API, configure the OAuth consent screen, and create an OAuth client of type **Web application**. While the consent screen is in Testing, add the intended Google accounts as test users. Google can expire testing-mode refresh tokens; reconnect if the token is revoked or expires. Work administrators may also restrict OAuth consent.

Register this exact authorized redirect URI:

```text
https://family-dashboard.jjayson400.workers.dev/api/google/callback
```

The Worker requests only:

```text
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.readonly
```

No Google profile/email scope or write scope is requested. When discovery returns a primary calendar, its ID (and email-shaped ID if present) is retained as account display metadata. This is not a verified identity claim and is never used as application authentication.

`GOOGLE_APP_ORIGIN` in `wrangler.jsonc` controls the exact callback and final redirect. It must be an HTTPS origin without a path, query, or trailing slash. HTTP is allowed only for `localhost` and `127.0.0.1`. Request query parameters cannot override redirects.

## Worker secrets

Existing secrets:

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
```

New secrets to configure before connecting:

- `GOOGLE_TOKEN_ENCRYPTION_KEY`: exactly 32 random bytes, encoded as standard base64 (44 characters, including the final `=`). Refresh tokens use AES-256-GCM with a fresh 12-byte IV, versioned metadata, and connection/household-bound authenticated data. Ciphertext and IV are stored in D1; access tokens are only held in memory during a request.
- `GOOGLE_ADMIN_KEY`: a separate random management credential of at least 32 characters. All Google endpoints except the OAuth callback require `Authorization: Bearer <key>`. The existing publicly reachable household API is not authentication; without this separate guard, anyone could connect an account, enable full event details, or disconnect your account. This is a temporary operator interface, not a household login system.

With Node and pnpm installed, generate each key independently and pipe it directly into Wrangler without writing a file or printing it to the terminal:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" | pnpm exec wrangler secret put GOOGLE_TOKEN_ENCRYPTION_KEY
```

Generate and save a **different** random 32-byte base64 value in your password manager for `GOOGLE_ADMIN_KEY`, then paste it at Wrangler's secret prompt:

```sh
pnpm exec wrangler secret put GOOGLE_ADMIN_KEY
```

Keep a secure backup of the encryption key. Replacing it makes existing refresh tokens unreadable. Disconnect and reconnect to switch keys in this phase; disconnect still works if encryption configuration is missing or broken. Never reuse the encryption key as the admin key. Never place any secret in a `VITE_*` variable, React source, GitHub, a URL, or browser local storage. `.dev.vars*` and `.env*` are ignored.

Automatic Workers request logging is disabled in the checked-in configuration because OAuth callback URLs contain short-lived authorization codes. Google errors returned to clients are sanitized; Google payloads and tokens are not logged. Do not enable request/header capture or `wrangler tail` during a live authorization flow without suitable redaction.

## Migration and deployment

Review `migrations/0002_google_calendar.sql`. It adds Google connection, calendar, OAuth-state, and operation-lease metadata, plus nullable `startInstant`/`endInstant` columns on existing events. It does not rewrite existing household data or change migration `0001`.

Migration `0003_google_calendar_members.sql` adds a household-scoped, single-member mapping table and a projection-version marker. Existing credentials, calendar selections and privacy settings are retained. Existing calendars start unassigned; none is assigned to a person automatically. The migration invalidates sync tokens once so the next successful sync removes previously imported working-location entries, including unchanged recurring occurrences. A failed refresh retains the previous display and retries the full refresh next time. The marker also handles an older Worker finishing a sync during deployment. Subsequent syncs remain incremental.

```sh
pnpm db:migrate:local
# Production operator / deployment pipeline only:
pnpm db:migrate:remote
```

The existing GitHub/Cloudflare pipeline deploy command applies pending migrations before deploying. Missing Google secrets do not affect normal household requests. Google remains unavailable until its secrets are configured. No manual production deployment is required for this change.

## API contract

All responses are `no-store`; the service worker bypasses `/api/`. Management requests require the admin bearer header, and browser requests must originate from `GOOGLE_APP_ORIGIN`. OAuth callbacks instead require a cryptographically random, 10-minute, single-use state record bound to an HttpOnly SameSite=Lax cookie. PKCE adds an authorization-code binding. The callback redirects only to the configured dashboard calendar.

| Endpoint                      | Request                                         | Result                                                                                          |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/google/connect`     | Admin header                                    | `{ authorizationUrl }` plus OAuth state cookie; navigate to this Google URL in the same browser |
| `GET /api/google/callback`    | Google code/state and matching cookie           | Connects account, then redirects to `/#calendar`; sanitized JSON error on failure               |
| `GET /api/google/status`      | Admin header                                    | `{ configured, connected, accountId, email, scopes }`; no credentials                           |
| `GET /api/google/calendars`   | Admin header                                    | Discovers all readable calendars with pagination; returns `{ calendars }`                       |
| `PATCH /api/google/calendars` | `{ sourceId, enabled, privacyMode, memberId? }` | Saves selection/privacy/member and returns `{ calendar }`                                       |
| `POST /api/google/sync`       | `{}` or `{ sourceId }`                          | Syncs enabled calendars, returning `{ synced: [{ sourceId, imported, full }] }`                 |
| `POST /api/google/disconnect` | `{}`                                            | Removes local Google connection/imports and returns `{ connected: false }`                      |

Calendar entries contain `googleId`, `sourceId`, `name`, `color`, `primary`, `enabled`, `privacyMode`, `memberId` (or `null`), and `lastSyncedAt`. Sync tokens, ciphertext, IVs, access tokens and refresh tokens are never in API responses. JSON bodies have the existing 64 KiB bound. Unknown settings and supplied event payloads are rejected.

Newly discovered calendars are disabled and use `busy`. Rediscovery preserves choices and removes imports for calendars no longer accessible. It never enables all calendars. Select an individual calendar and trigger sync deliberately. Source IDs are derived from the connection and calendar identity. Each calendar may be mapped to one existing household member using `memberId`. Omit `memberId` to preserve an existing mapping (backward-compatible with earlier clients); send `null` to clear it. Assignment changes immediately update existing imported events without contacting Google or resetting the sync token. New and updated imports use the same member through the existing `event_members` table, so normal member colors, avatars and filters apply even in busy mode. Disabled calendars retain their mapping for re-enabling. Unassigned calendars keep the existing Everyone behavior. Clear or reassign a calendar mapping before deleting its member; household-scoped foreign keys prevent dangling or cross-household assignments.

The existing household read endpoint is still publicly accessible unless the deployment has external access control. Any imported projection is visible to people who can open the dashboard. The admin key protects integration management, **not** household viewing. Choose privacy settings with that access model in mind.

## Connecting and syncing during development

Use a separate development OAuth client if possible. Register `http://localhost:8787/api/google/callback` in Google Cloud. Place development-only secrets and the following override in ignored `.dev.vars`:

```text
GOOGLE_APP_ORIGIN="http://localhost:8787"
```

Add your own values for the four documented secrets in that ignored file. Build, migrate, then use Wrangler directly so the origin stays consistent through OAuth (Vite's proxy rewrites the origin and is not used for this flow):

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate:local
pnpm exec wrangler dev --port 8787
```

Open `http://localhost:8787`. Until Phase 2 provides an operator UI, run this in that page's developer console. The same workflow works on the production origin using the production admin key. Do not paste the key into source code or share the console session:

```js
const admin = prompt('Google management key');
const response = await fetch('/api/google/connect', {
  headers: { Authorization: `Bearer ${admin}` },
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
location.assign(result.authorizationUrl);
```

After Google redirects back, a new console session can discover, select, and sync:

```js
const admin = prompt('Google management key');
async function google(path, method = 'GET', body) {
  const response = await fetch('/api/google/' + path, {
    method,
    headers: {
      Authorization: `Bearer ${admin}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
console.table((await google('calendars')).calendars);
// Choose a sourceId from the table; do not enable calendars indiscriminately.
const sourceId = prompt('Source ID of the calendar to import');
const household = await (await fetch('/api/household')).json();
console.table(household.family.map(({ id, name }) => ({ id, name })));
const memberId = prompt('Member ID to assign (leave blank for Everyone)') || null;
await google('calendars', 'PATCH', { sourceId, enabled: true, privacyMode: 'busy', memberId });
await google('sync', 'POST', { sourceId });
```

Use **Refresh household** to display imports. Status is `await google('status')`. To disable a calendar, PATCH it with `enabled: false`. To disconnect, call `await google('disconnect', 'POST', {})`. Reload the tab to discard console variables containing the admin key. Phase 2 should replace this manual interface with an appropriately protected management session/UI; do not bundle the admin credential into React.

## Sync and privacy decisions

- Google working-location entries are excluded using `eventType === "workingLocation"` or the presence of `workingLocationProperties`, never by title. The API requests only the working-location type, not office addresses or other details. Ordinary events titled "Home" remain eligible. Incremental sync still requests all event types so an excluded occurrence can delete its old dashboard projection. Full refreshes replace the source atomically; no Google event is changed.
- Google expands recurrence with `singleEvents=true`. Each occurrence is a stable, deterministic provider-independent event (`externalId` is the Google event ID, recurrence is `none`). Local repeating events still use existing household recurrence logic.
- Initial sync covers the preceding 30 days and following 365 days. Incremental requests reuse Google's `syncToken`, omit incompatible time bounds, and keep the other query parameters stable across pages. Changes outside the stored window are removed from the projection. A manual sync renews the window after 30 days or when the household timezone changes. There is no background scheduler in Phase 1.
- Every page must succeed and the final page must supply `nextSyncToken` before event changes and that token are committed atomically. A 410 clears the invalid token and retries a full sync. Previously displayed safe data remains until a complete replacement succeeds, avoiding destructive partial resets.
- HTTP calls have a 15-second timeout, one retry for 401 after refreshing access, and bounded pagination (20 discovery pages, 40 event pages per calendar). An invalid page, repeated page token, or exceeded limit reports an error without saving a partial calendar. Very large calendars may require a smaller window/background jobs in a later phase.
- A D1 lease serializes Google operations across Worker instances. A fenced atomic batch prevents a delayed sync from restoring data after disconnect or a privacy change. Every committed projection bumps the existing household revision, so stale household mutations reconcile normally. Each calendar commits separately; if a later calendar fails, earlier calendars may already have synced. Retry is safe because event IDs are deterministic.
- Timed imports use the household timezone. Optional UTC instants preserve exact intervals across daylight-saving folds. All-day dates remain calendar dates and Google's exclusive all-day end becomes the model's inclusive end date. Timed midnight ends are excluded from the following day's view. Google descriptions are displayed as plain text by existing React rendering; HTML is not executed.
- `busy`: title becomes `Busy`; original title, description, location, and attendee information are not persisted in the event projection. The household source label is generic.
- `title`: title and time only; no description, location, or attendee data.
- `full`: title, time, description→notes and location, bounded to existing model lengths. Attendees and other Google payload fields are not retained. Raw Google responses are never stored.
- Changing privacy or disabling a calendar immediately deletes its old projection and clears its sync token. A subsequent deliberate sync repopulates an enabled calendar under the new privacy setting. This also works while Google is unavailable.
- Disconnect deletes encrypted credentials, OAuth state, calendar mappings, imported events, and associated Google sources. Local events, sources, family, chores, meals and lists are untouched. It removes local access; it does not revoke the app's grant at Google. The owner can remove that grant separately in Google Account permissions.

## Validation

Google HTTP responses are mocked; automated tests require no Google credentials. Tests exercise real local D1 and include OAuth state/cookies/replay, encryption/tampering, discovery, paginated full/incremental sync, deletion and 410 recovery, failed-page rollback, token refresh, privacy changes, protected mutations, disconnect, lease fencing, member mapping/reassignment, working-location filtering, and upgrading existing Google connections. Browser tests verify imported-event member color/filter/identity and read-only details.

```sh
pnpm format:check
pnpm test
pnpm build
pnpm test:e2e
```

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync), [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [calendarList.list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list).
