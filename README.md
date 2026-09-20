# Our Home · Family Dashboard

A responsive family dashboard for landscape tablets, phones, and desktop browsers. React and TypeScript provide the existing five-section interface; a Cloudflare Worker serves the app and its API, and **Cloudflare D1 stores household data**.

## Local setup

Use Node 24.18.0 (22.12+ supported) and pnpm 10.11.1. The repository is a single app, with no pnpm workspace. Dependency build permissions are in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev
```

Open `http://localhost:5173`, or `http://YOUR-PC-LAN-IP:5173` on the iPad. The development script builds the app shell and starts Vite on the LAN plus Wrangler on loopback port 8787. Vite forwards `/api` to Wrangler; both devices use the same **local** D1 database. Allow the development server through Windows Firewall on your private network if needed. Local migrations and development never use production D1. Wrangler stores local data under `.wrangler/`; keep that directory to preserve your local household between restarts.

The demo seed is optional. Skip it for an empty household. Without it, add family members using the header avatars and create lists from Lists. `pnpm db:seed:local` deliberately adds relative-date sample events, chores, meals, members, and lists **once**. `seed_history` prevents re-running either seed mode from recreating deleted records. Seeding uses insert-only statements and never replaces an existing record. Seed a fresh, migrated database before people start editing it; seeding is not a restore/merge/import tool. The Worker never seeds on startup.

```sh
pnpm build              # Check browser + Worker types, build dist/
pnpm preview            # Serve the built app + API via local Wrangler on port 4173
pnpm preview:worker     # Build, then the same local Worker preview
pnpm cf:types           # Regenerate binding types after Wrangler config changes
pnpm deploy:check       # Build and validate a deployment without publishing
pnpm test               # Recurrence, optimistic store, and real local D1 API tests
pnpm format:check       # Formatting
```

## Production setup and deployment

The configured Worker is `family-dashboard`. `wrangler.jsonc` declares `worker/index.ts`, the static `dist/` assets, and the D1 binding **DB**. API routes run through the Worker first; other routes serve the SPA. Deploy this project as a Worker, not as a static-only Pages site.

Authenticate with your own account and create the database **once**:

```sh
pnpm exec wrangler login
pnpm db:create
```

Copy the returned database UUID into `d1_databases[0].database_id` in `wrangler.jsonc`. The database name is `family-dashboard`; the UUID is an identifier, not a secret. For the existing deployment, use the already-provisioned database ID in that file instead of creating another database.

Review `migrations/0001_household.sql`, then initialize and optionally seed production:

```sh
pnpm db:migrate:remote
pnpm db:seed:starter
pnpm deploy:check
pnpm deploy
```

`db:seed:starter` is a deliberate, one-time production command. It creates the four editable starter family members (Jason, Kelly, Mia, Liam) and empty Groceries, Household, and Shopping lists. It does **not** create sample calendar events, chores, meals, or shopping items. Omit it to start entirely empty. `db:seed:generate` produces the same reviewed SQL in the ignored `.wrangler/seed-starter.sql` without executing it. Remote demo seeding is explicitly rejected.

`pnpm deploy` builds, applies any pending version-controlled D1 migrations, and then publishes the Worker and assets. Migration failure stops deployment. Wrangler tracks applied files in `d1_migrations`; an already-applied migration is not run again. Never edit a migration after it has been applied: add a numbered migration for subsequent changes. Review any future destructive migration and take a database export/Time Travel checkpoint before applying it. Rolling back the Worker does not roll back D1 data.

For Git-connected Cloudflare Workers Builds:

| Setting       | Value                                                 |
| ------------- | ----------------------------------------------------- |
| Repository    | `JasonJohnson2/family-dashboard`                      |
| Branch / root | `main` / repository root                              |
| Install       | `pnpm install --frozen-lockfile`                      |
| Build         | `pnpm build`                                          |
| Deploy        | `pnpm db:migrate:remote && pnpm exec wrangler deploy` |
| Node / pnpm   | `24.18.0` / `10.11.1`                                 |

The build identity needs Workers deployment and D1 edit permissions for this account. Keep API tokens in Cloudflare's build secret settings or a local environment, never in source control. `.env*`, `.dev.vars*`, `.wrangler/`, and generated artifacts are ignored. No database password is sent to the browser; only the Worker has the DB binding. No scheduled jobs or paid-only features are required. Check current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) as household usage grows.

**Access model:** authentication is intentionally outside this phase. Anyone who can reach this deployment can read or change this one household. The same-origin write checks prevent casual cross-site form requests; they are not authentication or access control. Choose access control before storing sensitive family details on a publicly reachable deployment.

## Persistence and synchronization

- The app fetches household state when opened, when a tab becomes visible or focused, when connectivity returns, and every 60 seconds while visible. “Refresh household” also fetches immediately.
- Checkbox changes render immediately. Writes are queued in order and the server returns authoritative state. Forms wait for confirmation before closing; failed forms retain their entered text.
- Every mutation carries a household revision and a unique request ID. Writes, assignment changes, completion changes, a retry receipt, and the revision increment commit atomically in a D1 batch. Prepared/bound SQL is used for all runtime values.
- If another device saved first, a stale write receives a conflict instead of overwriting its changes. The app loads the latest state, reports the conflict, and asks the user to review/reapply their change. This uses a single household-wide revision, intentionally favoring simplicity over automatic field merging.
- Failed optimistic changes revert to confirmed data. A visible error offers refresh or **Retry save**. Retrying an uncertain network failure uses the exact same request ID and payload, so a response lost after a successful commit does not duplicate data. Later queued changes are reverted with an explicit message to re-enter them. **Dismiss** abandons the pending retry; no offline write queue is stored across reloads.
- Household data is never cached by the service worker. The installed app shell can open offline, but initial data loading and saves require a connection. An already-open page keeps its last confirmed state; failed saves remain visible. Reconnect/refetch to recover. Wait for “Household up to date” before closing the app; a pending-save unload guard helps prevent accidental navigation.
- Existing prototype changes lived only in browser memory and cannot be recovered from a prior refresh. The new database starts deliberately; it does not import an old tab's demo state.

## Editing calendar events

Open an event from Home or any Calendar view and tap **Edit event**. The form opens with the saved name, date/time, all-day setting, assignments, repeat schedule, location and notes. **Save event** updates the same persistent event; Cancel leaves it unchanged. For recurring events, editing applies to the entire series (including earlier occurrences), and the form uses the original series start date. Single-occurrence exceptions remain future work. Existing timezone, source identity, multi-day end date and repeat-until information are retained. The form stays open with your draft if saving fails.

## Schema and calendar boundary

`households` contains the singleton `home`, its display name, timezone, and revision. Members, calendar sources/events, chores, meals, lists/items, assignments, completions, and mutation receipts reference `household_id`. Composite foreign keys prevent assignments from crossing household boundaries. List/item and event/chore assignment children cascade on deletion; deleting an assigned member is rejected until assignments are removed. Meals are unique per household/date, and list names are unique per household ignoring ASCII case.

Calendar events retain provider-independent `sourceId`, optional `externalId`, timezone, member IDs, and structured recurrence. The initial source is `local`; API-created events must use it. The `CalendarProvider` contract remains intact, and `icloud`/`google` source types are reserved without any external synchronization implementation or chosen CalDAV strategy.

Recurrence supports none, daily, weekdays, weekly, and monthly, with an optional end date. Monthly dates on the 29th–31st skip months lacking that day. Completion is stored separately per chore/due date, so editing a chore does not erase completion history and completing today does not complete tomorrow. Event exceptions/full RRULE parsing and timezone conversion remain future work. Dates and greetings still follow the viewing device's local timezone; persisted household/event timezones preserve the model boundary without changing current display behavior.

Meals and list items retain optional recipe references for later use, with no recipe functionality added. Weather remains a labeled static sample. No account management, authentication, external calendars, live weather, recipes, AI, or WebSockets are implemented.

## API

- `GET /api/household` returns the current household, family, sources, events, chores, meals, and lists/items. Responses use `Cache-Control: no-store`.
- `POST /api/mutations` accepts `{ id, revision, operations }`. `src/data/contracts.ts` contains the shared validated contract. Operations support member/event/chore/meal/list/item upserts, item completion, occurrence-specific chore completion, deletion, and household settings. Chore upserts preserve existing completion history; use `chore.complete` to change it.
- Validation errors return 400, missing completion targets return 404, stale revisions/request-ID mismatches return 409, relational conflicts return 422, and unavailable storage returns 503. Same-request retries return the latest household state. Requests are limited to 64 KiB and 20 operations; an additional SQL statement cap keeps batches within the Workers Free query budget.
- There is no browser-selectable household ID, arbitrary SQL endpoint, production reset endpoint, or runtime seeding endpoint.

## Tests

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm exec playwright install chromium webkit
pnpm build
pnpm test:e2e
pnpm deploy:check
```

API tests use real local D1 through Miniflare and apply the checked-in migrations. They cover model creation/edit/deletion, check/uncheck, recurrence, assignment integrity, settings, seed idempotence, tenant scoping, injection-safe text, validation, atomic rollback, revision races, retry deduplication, and persistence across a complete runtime restart. Store tests cover optimistic updates, ordered saves, failures, conflicts, and stale refetch responses.

Browser tests run the existing tablet Chromium and phone WebKit flows against an isolated real D1 test database, plus reload/cross-device persistence, refetch, and failed-save recovery. The test-only loopback server in `scripts/test-server.ts` owns its reset endpoint; it is never bundled into the production Worker. Tests run sequentially to isolate database state. Chromium verifies the offline app shell and reconnection. Playwright WebKit on Windows has an existing offline-navigation limitation, so that single check is skipped; validate it on the physical iPad.

## Project layout

```text
src/data/contracts.ts       Validated API contracts and optimistic operations
src/data/api.ts             Browser HTTP client and timeout handling
src/data/controller.ts      Save queue, revisions, retry/reconciliation
src/store.tsx               React household state and resume/refetch lifecycle
src/data/calendarProvider.ts Provider-independent calendar boundary
src/data/mock.ts            Explicit seed/test fixtures only
src/components/             Existing five-section UI and sync status
worker/index.ts             Same-origin JSON API and asset routing
worker/database.ts          Prepared SQL, household scoping and atomic mutations
migrations/                 Version-controlled schema changes
scripts/                    Development, deliberate seeds, local test harness
wrangler.jsonc              Worker assets and D1 binding
```

## iPad and wall display

Landscape tablets retain the sidebar and card grid; portrait tablets and phones adapt to fewer columns or bottom navigation. On iPad Safari, use **Share → Add to Home Screen** and open the icon for the standalone experience. Installation and service workers require HTTPS or localhost; HTTP LAN testing supports the UI/API but not offline installation. The update prompt preserves saved data; finish any open unsaved form before updating. Screen wake, auto-lock and kiosk controls remain device settings.

## Assets

Landscape photograph: [Unsplash source](https://images.unsplash.com/photo-1470770841072-f978cf4d019e), bundled locally; [Unsplash license](https://unsplash.com/license). DM Sans and Lora are bundled via Fontsource under their included SIL Open Font Licenses. Icons use Lucide (ISC). The app/home-screen icon is an original SVG included in this repository.
