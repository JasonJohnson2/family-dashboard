# Google Calendar: Phase 1

This is a server-side, read-only integration for one Google account in the existing household. No Google events are created, edited, or deleted. The existing React calendar displays normalized imports alongside local plans. Google imports cannot be edited through `/api/mutations`; local event editing continues unchanged. Connection management is available in Settings → Calendar Connections. Multiple Google accounts and push notifications remain future work. Enabled calendars sync on Calendar-page stale checks or through the Sync calendars button; all paths share the same sync service.

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

No Google profile/email scope or write scope is requested. When connection validates the primary calendar (and during discovery), its ID (and email-shaped ID if present) is retained as account display metadata. This is not a verified identity claim and is never used as application authentication.

`GOOGLE_APP_ORIGIN` in `wrangler.jsonc` controls the exact callback and final redirect. It must be an HTTPS origin without a path, query, or trailing slash. HTTP is allowed only for `localhost` and `127.0.0.1`. Request query parameters cannot override redirects.

## Worker secrets

Existing secrets:

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
```

New secrets to configure before connecting:

- `GOOGLE_TOKEN_ENCRYPTION_KEY`: exactly 32 random bytes, encoded as standard base64 (44 characters, including the final `=`). Refresh tokens use AES-256-GCM with a fresh 12-byte IV, versioned metadata, and connection/household-bound authenticated data. Ciphertext and IV are stored in D1; access tokens are only held in memory during a request.
- `GOOGLE_ADMIN_KEY` (optional for browser management): a separate random management credential of at least 32 characters, retained for administrative clients. Management requires a household session as well. Browser operators use the existing short-lived, session-bound operator PIN token instead; do not enter the Google admin key in browser JavaScript. Refresh requires household access without management privilege; callback validates its one-use OAuth flow and initiating session.

With Node and pnpm installed, generate each key independently and pipe it directly into Wrangler without writing a file or printing it to the terminal:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" | pnpm exec wrangler secret put GOOGLE_TOKEN_ENCRYPTION_KEY
```

Generate and save a **different** random 32-byte base64 value in your password manager for `GOOGLE_ADMIN_KEY`, then paste it at Wrangler's secret prompt:

```sh
pnpm exec wrangler secret put GOOGLE_ADMIN_KEY
```

Keep a secure backup of the encryption key. Replacing it makes existing refresh tokens unreadable. Restore the original encryption key or use the same-account Reconnect flow after configuring a replacement key; disconnect still works if encryption configuration is missing or broken. Never reuse the encryption key as the admin key. Never place any secret in a `VITE_*` variable, React source, GitHub, a URL, or browser local storage. `.dev.vars*` and `.env*` are ignored.

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

## Calendar-page synchronization and D1 write usage

**There is no recurring Google sync or background cron.** `wrangler.jsonc` explicitly declares `"triggers": { "crons": [] }` and the Worker has no scheduled handler. The empty array removes the previously deployed 15-minute trigger through the normal deployment pipeline; simply omitting `triggers` would leave the old trigger active ([Cloudflare documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)). No manual Cloudflare change is required.

Opening/navigating to Calendar or returning focus/visibility/network while Calendar is open checks cached Google data. An enabled calendar is stale after **one hour** since its last successful sync (or if it has never synced). Fresh, disconnected, disabled and cooldown checks are read-only: they do not contact Google or acquire/write a lease. Stale eligibility is checked again under the existing lease to close the multi-device race. There is no recurring Google timer on Calendar or other pages. The existing household read timer remains, so other-device changes still appear without starting Google sync.

Calendar's **Sync calendars** button bypasses the one-hour stale threshold. It shows **Syncing...**, disables repeat clicks until completion, refetches household state after successful imports and shows a small result/error message. A durable **60-second** per-calendar attempt cooldown protects this authenticated household action from repeated clicks/tabs/HTTP clients. If another sync just ran, the button reports that calendars were recently checked. Automatic failure retries are limited to **one per hour**. Both use the existing `last_attempt_at` from migration `0004`; the sync scheduling policy itself needs no extra secrets. Migration `0009` adds connection recovery metadata.

All imports remain read-only, use existing encrypted OAuth tokens and respect enabled calendars, privacy and member settings. No credentials are sent to React. A failed calendar keeps its cached events; other enabled calendars can continue. Missing configuration, revoked authorization and provider failures yield only sanitized status/error messages. Invalid sync tokens still recover through a full sync. The existing fenced two-minute operation lease and atomic per-calendar batches remain in place. Slow Google requests never block `/api/household` or local saves.

### Write audit and optimization

Previously, every sync deleted/recreated **all** `event_members` rows for the source, including unchanged events, and incremented household revision. Incremental items were upserted without comparing their projected values. Full refreshes deleted and recreated all source events. Even fresh dashboard checks wrote lease rows, and global minute polling plus 15-minute cron caused frequent checks.

Now, synchronization compares normalized incoming events with existing source rows under the lease. Only new or visibly changed event projections are upserted; only actually removed/excluded events are deleted. Full refresh/410 recovery uses the same comparison, preserving identical rows instead of rebuilding the source. Member links are added/removed only when they differ. Local/other-source ID collisions remain protected. The household revision changes only when visible events or member assignments change. Token/window/last-success metadata is saved with the event delta in the same fenced batch; updates have value-difference predicates. Attempt metadata is still recorded before Google HTTP to protect against retries after a Worker interruption.

An empty or identical incremental response therefore writes **zero event rows, zero member rows and zero household revision rows**. Actual syncs retain a small constant amount of lease/fence/attempt/token/timestamp writes independent of the number of cached events. Fresh/no-op requests write **zero D1 rows**, including lease metadata. Tests use D1's `rows_written` metadata and SQLite triggers that reject any event/member rewrite during no-change incremental and 410 refreshes of 250 mapped events. In the local D1 fixture, a no-change sync with 250 mapped events used 11 total `rows_written`; unchanged 410 recovery used 15. These are measured test-fixture totals (including metadata/index overhead), not a guarantee for every database/runtime. This intentionally optimizes writes rather than reducing synchronization correctness. Cloudflare's [D1 pricing documentation](https://developers.cloudflare.com/d1/platform/pricing/) explains that index changes also count toward rows written.

### Status, endpoint safety and troubleshooting

`GET /api/google/refresh` only reads non-sensitive status: `connected`, `enabledCalendars`, `lastSyncedAt`, `stale`, `syncing`, `needsAttention` and `lastFailure`. `lastSyncedAt` is the oldest successful timestamp across enabled calendars, or `null` until all have synced. `syncing` means a live Google operation lease exists. Failure codes are limited to `authorization`, `configuration`, and `unavailable`; successful sync clears a calendar's failure. The protected `/api/google/status` also includes this object as `sync`.

`POST /api/google/refresh` accepts `{}` for stale refresh or `{ "manual": true }` for the button. It requires a same-origin `Origin` header and JSON content type, rejects cross-site requests and unknown fields, and returns `{ outcome, synced, status }`. Outcomes are `complete`, `busy`, `cooldown`, or `unavailable`; `synced` counts successful calendars. Inspect `status.needsAttention` for partial failures. This narrow household capability cannot choose arbitrary sources, change settings or return account details/tokens. Server-side staleness, cooldowns and leases apply regardless of caller; origin checks alone are not authentication. Management APIs require household authentication plus an admin bearer credential or a session-bound operator token.

For administrative troubleshooting, the existing protected `POST /api/google/sync` with `{}` or `{ "sourceId": "chosen-source" }` bypasses both stale and household-button cooldown checks. It still uses the shared lease, comparison and atomic sync implementation. No DevTools are needed for the normal household button. No new OAuth scopes, reconnect or manual Cloudflare setup is required for working connections. The GitHub → Cloudflare pipeline handles deployment and removal of the old trigger; existing assets, D1 binding, origin and deployment commands are unchanged.

## API contract

All responses are `no-store`; the service worker bypasses `/api/`. Every route except callback requires a household cookie. Management requests (everything except `/refresh` and callback) additionally require an admin bearer header or `X-Reward-Operator` token, and browser requests must originate from `GOOGLE_APP_ORIGIN`. OAuth callbacks instead require a cryptographically random, 10-minute, single-use state record bound to an HttpOnly SameSite=Lax cookie. The OAuth state also references a still-valid household session. PKCE adds an authorization-code binding. The callback returns to Calendar Connections. Browser errors redirect with an application-owned category only; non-browser clients receive sanitized JSON errors.

| Endpoint                      | Request                                                       | Result                                                                                                    |
| ----------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/google/refresh`     | Household cookie; no operator token                           | Non-sensitive cached sync status; no Google request                                                       |
| `POST /api/google/refresh`    | Household cookie; same-origin JSON `{}` or `{ manual: true }` | Stale/manual sync with server cooldown and status                                                         |
| `GET /api/google/connect`     | Household cookie + management authorization                   | `{ authorizationUrl }` plus OAuth state cookie; navigate to this Google URL in the same browser           |
| `GET /api/google/reconnect`   | Household cookie + management authorization                   | Same-account OAuth recovery preserving saved configuration                                                |
| `GET /api/google/callback`    | Google code/state and matching cookie                         | Connects account, then redirects to `/#connections?google=connected`; browser failures return to settings |
| `GET /api/google/status`      | Household cookie + management authorization                   | `{ configured, connected, accountId, email, scopes, calendars, sync }`; no credentials                    |
| `GET /api/google/calendars`   | Household cookie + management authorization                   | Discovers all readable calendars with pagination; returns `{ calendars }`                                 |
| `PATCH /api/google/calendars` | `{ sourceId, enabled, privacyMode, memberId? }`               | Saves selection/privacy/member and returns `{ calendar }`                                                 |
| `POST /api/google/sync`       | `{}` or `{ sourceId }`                                        | Syncs enabled calendars, returning `{ synced: [{ sourceId, imported, full }] }`                           |
| `POST /api/google/disconnect` | `{}`                                                          | Removes local Google connection/imports and returns `{ connected: false }`                                |

Calendar entries contain `googleId`, `sourceId`, `name`, `color`, `primary`, `enabled`, `privacyMode`, `memberId` (or `null`), and `lastSyncedAt`. Sync tokens, ciphertext, IVs, access tokens and refresh tokens are never in API responses. JSON bodies have the existing 64 KiB bound. Unknown settings and supplied event payloads are rejected.

Newly discovered calendars are disabled and use `busy`. Rediscovery preserves choices and removes imports for calendars no longer accessible. It never enables all calendars. Select an individual calendar deliberately; automatic refresh then keeps it current. Manual sync remains available to force an immediate refresh. Source IDs are derived from the connection and calendar identity. Each calendar may be mapped to one existing household member using `memberId`. Omit `memberId` to preserve an existing mapping (backward-compatible with earlier clients); send `null` to clear it. Assignment changes immediately update existing imported events without contacting Google or resetting the sync token. New and updated imports use the same member through the existing `event_members` table, so normal member colors, avatars and filters apply even in busy mode. Disabled calendars retain their mapping for re-enabling. Unassigned calendars keep the existing Everyone behavior. Clear or reassign a calendar mapping before deleting its member; household-scoped foreign keys prevent dangling or cross-household assignments.

The household read endpoint and imported projections require household authentication. Member selection does not grant access. Choose privacy modes for everyone who shares trusted household access; management remains separately privileged.

## Connecting and syncing during development

Use a separate development OAuth client if possible. Register `http://localhost:8787/api/google/callback` in Google Cloud. Place development-only secrets and the following override in ignored `.dev.vars`:

```text
GOOGLE_APP_ORIGIN="http://localhost:8787"
```

Add your own values for the required OAuth and encryption secrets (and the existing operator PIN) in that ignored file. Build, migrate, then use Wrangler directly so the origin stays consistent through OAuth (Vite's proxy rewrites the origin and is not used for this flow):

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate:local
pnpm exec wrangler dev --port 8787
```

Configure a development household credential using [household access setup](household-access.md), open `http://localhost:8787`, and sign in. Follow the normal interface below. No console or admin key is needed in the browser.

## Household connection management

1. Open **Settings → Calendar Connections** (on a phone, **More → Settings**). Calendar's **Calendar connections** button opens the same controls.
2. Select **Unlock operator controls** and enter the existing household operator PIN.
3. Select **Connect Google Calendar**, choose your Google account and grant both read-only calendar permissions. The dashboard uses the existing offline OAuth, PKCE, single-use browser/session-bound state and encrypted refresh-token storage.
4. Google returns to **Calendar Connections**. Unlock again (operator tokens remain in memory only), then select **Discover Google calendars**. Newly discovered calendars start disabled in **Busy only** mode.
5. Choose **Show on dashboard**, **Privacy**, and **Assigned to** for each desired calendar. The member picker uses the current household members, including adults and children. Select **Save calendar**, then **Sync Now**.

Opening/reloading these settings only reads saved status/calendar configuration. It never starts discovery or provider sync. **Sync Now** retains the existing one-minute manual cooldown; ordinary Calendar checks retain the one-hour policy. Saving settings follows the existing privacy/member behavior and does not force a sync.

**Sign-in required** means a new token refresh returned `invalid_grant`, a granted token lacks the required scopes, or the Calendar API rejected refreshed credentials twice with HTTP 401. Select **Reconnect Google Calendar**, choose the **same Google account**, grant both permissions, unlock again and select **Sync Now**. Reconnect keeps the connection/source IDs, enabled calendars, privacy modes, member mappings, incremental sync tokens/windows and cached events. It replaces only the encrypted credential and clears authorization/attempt metadata so a retry can proceed. A different account is rejected before saving anything. Disconnect is never part of the recovery sequence.

**Temporarily unavailable** means a network/provider error, rate limit or unreadable response; retry **Sync Now** after the cooldown. **Configuration needs attention** means missing/unreadable encryption/OAuth configuration or an invalid OAuth client; the owner should check Worker secrets. Neither condition is automatically labeled expired sign-in. Old ambiguous authorization warnings remain **Needs attention** until a new check establishes the cause. Do not delete/recreate calendars to clear warnings.

**Disconnect Google Calendar** opens a confirmation explaining that dashboard imports will be removed. **Cancel** keeps everything. **Confirm Google disconnect** removes only the Google connection, source mappings and imported events; Google itself, local events and iCloud data are unchanged.

Migration `0009_google_reconnect.sql` adds two connection health columns and a connection reference on OAuth state records. Existing connections default to no forced reconnect, preserving all credentials, source IDs, selections, mappings and cached data. This additive migration is applied by the normal GitHub → Cloudflare deployment migration command; no credentials or destructive production reset are required. Browser management needs the existing operator PIN secret, OAuth client secrets, origin and token-encryption key; `GOOGLE_ADMIN_KEY` is optional for legacy administrative clients only.

Google's [OAuth documentation](https://developers.google.com/identity/protocols/oauth2) explains that external consent apps in Testing normally issue refresh tokens valid for seven days for Calendar scopes; revocation and account/security policy can also require reconnect. An `invalid_grant` error does not identify which cause occurred. Testing status must be checked in Google Cloud rather than inferred from the dashboard warning.

## Sync and privacy decisions

- Google working-location entries are excluded using `eventType === "workingLocation"` or the presence of `workingLocationProperties`, never by title. The API requests only the working-location type, not office addresses or other details. Ordinary events titled "Home" remain eligible. Incremental sync still requests all event types so an excluded occurrence can delete its old dashboard projection. Full refreshes replace the source atomically; no Google event is changed.
- Google expands recurrence with `singleEvents=true`. Each occurrence is a stable, deterministic provider-independent event (`externalId` is the Google event ID, recurrence is `none`). Local repeating events still use existing household recurrence logic.
- Initial sync covers the preceding 30 days and following 365 days. Incremental requests reuse Google's `syncToken`, omit incompatible time bounds, and keep the other query parameters stable across pages. Changes outside the stored window are removed from the projection. The shared sync service renews the window after 30 days or when the household timezone changes. Calendar-page and manual refresh use this same behavior.
- Every page must succeed and the final page must supply `nextSyncToken` before event changes and that token are committed atomically. A 410 clears the invalid token and retries a full sync. Previously displayed safe data remains until a complete replacement succeeds, avoiding destructive partial resets.
- HTTP calls have a 15-second timeout, one retry for 401 after refreshing access, and bounded pagination (20 discovery pages, 40 event pages per calendar). An invalid page, repeated page token, or exceeded limit reports an error without saving a partial calendar. Very large calendars may require a smaller window/background jobs in a later phase.
- A D1 lease serializes Google operations across Worker instances. A fenced atomic batch prevents a delayed sync from restoring data after disconnect or a privacy change. Every committed projection bumps the existing household revision, so stale household mutations reconcile normally. Each calendar commits separately; if a later calendar fails, earlier calendars may already have synced. Retry is safe because event IDs are deterministic.
- Timed imports use the household timezone. Optional UTC instants preserve exact intervals across daylight-saving folds. All-day dates remain calendar dates and Google's exclusive all-day end becomes the model's inclusive end date. Timed midnight ends are excluded from the following day's view. Google descriptions are displayed as plain text by existing React rendering; HTML is not executed.
- `busy`: title becomes `Busy`; original title, description, location, and attendee information are not persisted in the event projection. The household source label is generic.
- `title`: title and time only; no description, location, or attendee data.
- `full`: title, time, description→notes and location, bounded to existing model lengths. Attendees and other Google payload fields are not retained. Raw Google responses are never stored.
- Changing privacy or disabling a calendar immediately deletes its old projection and clears its sync token. A subsequent automatic or manual sync repopulates an enabled calendar under the new privacy setting (automatic attempts respect the cooldown). This also works while Google is unavailable.
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

Sync coverage includes read-only fresh/no-op checks, one-hour staleness, the household manual button and cooldown, shared-lease concurrency, failure isolation, credential protection, incremental/410 recovery, no-change D1 write counts, and Calendar-only browser refresh without delaying household rendering.

## Shared refresh with iCloud

The Calendar page now calls `/api/calendar/refresh`, which coordinates the existing Google refresh service with read-only iCloud refresh and reports per-provider outcomes. The original `/api/google/*` endpoints, OAuth, privacy, mapping, incremental tokens and PIN/admin authorization remain compatible. Shared projection/encryption/lease helpers preserve Google's v1 ciphertext associated data and existing Google lease tables. A shared outbound budget protects the Worker free-tier subrequest limit. See [iCloud setup](icloud-calendar.md); no Google reconnection or new Google settings are required.

Status reads are isolated per provider too. If a connection-status database read fails after a sync commits, the response retains the completed sync count so the browser reloads saved events, and reports `calendar_status / database` without exposing SQL or credentials. A generic HTTP 503 is not proof of expired Google authorization: inspect its response body to distinguish an application error from a Cloudflare runtime failure. Do not reconnect or reset saved calendars solely because of that HTTP status.

### Cloudflare Error 1102

An HTML response titled **Worker exceeded resource limits** with code **1102** is generated by Cloudflare when the Worker exceeds CPU or memory limits. JavaScript error handling cannot catch a platform termination. In **Workers & Pages → family-dashboard → Metrics → Errors → Invocation Statuses**, distinguish **Exceeded CPU Time Limits** from **Exceeded Memory**. Share only the outcome/CPU limit when troubleshooting, never OAuth request URLs, cookies or credentials. Request logging remains disabled for sensitive calendar/authentication routes.

Workers Free allows 10 ms of CPU per HTTP invocation; time waiting for providers is not CPU time. Parsing, recurrence expansion, validation and projection preparation previously ran in that invocation. A small bounded timezone-formatter cache reduces repetitive allocation in both importers and household validation. Retries, longer network timeouts, `waitUntil`, or clearing stored tokens do not increase the CPU allowance.

Synchronization now runs in one SQLite-backed Durable Object dedicated to the household (`CalendarSync`, binding `CALENDAR_SYNC`). Durable Objects are available on Free and have a default 30-second CPU allowance. After household/origin/input checks, the Worker delegates `/api/calendar/refresh` POST and the legacy `/api/google/refresh` POST through the internal binding. Google operator/admin Sync Now (`/api/google/sync`) delegates only after its existing management gate succeeds. GET status requests remain read-only in the normal Worker. Browser cookies, authorization headers and operator tokens are not forwarded to the executor.

Existing D1 tables, encrypted credentials, provider leases, incremental tokens, cooldowns, privacy settings, member mappings and atomic projection commits remain authoritative. Every executor invocation has a fresh shared budget of 40 external requests; the existing per-provider deadlines still apply. The Object has no public endpoint, scheduled alarm, polling loop or separate event datastore. It never writes Object storage. This change targets the confirmed **Exceeded CPU Time Limits** failure; it does not change iCloud responses or remove provider-level failures.

`wrangler.jsonc` includes the binding and the `calendar-sync-v1` class-registration migration using `new_sqlite_classes`, required on Free. Deployment registers the class automatically; do not run this as a D1 migration. No additional secret or database creation command is needed, and existing D1 tables/records are not altered. Keep the registration migration in version control after deployment. Use the existing local development/deployment commands; restart local Wrangler after adding the binding. Normal missing-binding failure is closed (`calendar_executor`); production never falls back to the 10 ms sync path.

The Object uses Free-plan compute allowances (currently 100,000 requests/day and 13,000 GB-seconds/day), separately from D1 quotas. It is active only during an incoming operation; no ongoing background job is added. The existing hourly stale checks/manual cooldown avoid constant work. Integration tests exercise the real SQLite-backed binding in workerd, and provider suites continue checking HTTP failures, atomic rollback and write counts. Local runtimes do not reproduce Cloudflare's production CPU enforcement; verify production **Metrics → Errors → Invocation Statuses** after deployment.

References: [Workers resource limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers errors](https://developers.cloudflare.com/workers/observability/errors/), [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
