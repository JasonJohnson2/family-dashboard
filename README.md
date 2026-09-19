# Our Home · Family Dashboard

A responsive household dashboard inspired by the supplied UI mockup: scenic landscape header, family colors, soft cards, and one-tap access to Home, Calendar, Chores, Meals, and Lists. Built with React, TypeScript, and Vite; deployed as static assets on **Cloudflare Workers**.

## Run locally

Install Node.js 22.12+ (Node 24 LTS recommended) and pnpm 11. This repository includes `pnpm-lock.yaml` for reproducible installs.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:5173`. The development server binds to `0.0.0.0` so an iPad on the same Wi-Fi can open `http://YOUR-PC-LAN-IP:5173`. Use the network URL printed by Vite; allow the development server on your private network if Windows Firewall asks. No app accounts or environment variables are required.

```sh
pnpm build           # TypeScript check + production build into dist/
pnpm preview         # Preview the production build on port 4173
pnpm preview:worker  # Build + preview through the local Workers runtime
pnpm deploy:check    # Build + Wrangler dry-run; does not publish
pnpm test            # Date and recurrence tests
pnpm format:check    # Check source formatting
```

Browser checks use the production build:

```sh
pnpm exec playwright install chromium webkit
pnpm build
pnpm test:e2e
```

The browser suite covers the five sections, responsive overflow, event recurrence, chore completion, list changes, meal editing, family names, modal validation, refresh reset, and the installed app's offline shell. Chromium runs in a landscape tablet viewport; WebKit runs in a phone viewport. Offline reload is verified in Chromium. The WebKit offline-navigation test is explicitly skipped because Playwright WebKit on Windows reports an internal browser error when forced offline; verify this behavior on the physical iPad. All other UI and LAN-ID checks run in both engines. Browser emulation does not replace testing on the physical iPad.

## What's included

- **Home:** local current date and greeting, explicitly labeled sample weather for Fonda, today's events, chores and progress, upcoming events, meals, shared lists, and functional quick actions.
- **Calendar:** day/week/month views, previous/next/today controls, family filters, event details, creation, all-day events, member assignment, and basic recurrence.
- **Chores:** creation, assignments, due dates, repeat schedules, filtering, date navigation, and completion per occurrence. Overdue one-time chores remain visible. Recurring chores get a new checkbox on each due date.
- **Meals:** week navigation, one dinner per day, editing/removing meals, meal icons and notes. Recipe references are reserved in the data model.
- **Lists:** Groceries, Household, Shopping, new named lists, and adding/checking/removing items. Home and Lists share the same state.
- **Family:** editable names and colors, initials, and adding members. Open the avatars in the header.
- **PWA:** manifest, home-screen icons, local fonts and landscape artwork, offline app-shell caching, and an explicit update prompt. A new version does not automatically reload an active household session.

**This is a prototype.** All household data lives in React state in a single browser tab. Changes reset on reload and do not sync across tabs or devices. Offline caching stores only the application assets, not household changes. Weather is a static sample. There is no database, authentication, calendar synchronization, or external API connection. Demo events and meals are seeded relative to the device's current date. The clock/date follows the viewing device's timezone.

## iPad and wall display

Landscape tablets use a sidebar and card grid. Portrait tablets use fewer columns; phones use a bottom navigation bar and stacked cards. Forms use native date/time inputs and dialogs, labeled controls, keyboard focus handling, and larger touch targets. The complete dashboard can scroll on shorter screens so information stays readable.

For the installed experience, open the deployed HTTPS URL in **Safari → Share → Add to Home Screen**, then launch from its icon. HTTPS (or localhost) is required for the service worker. A plain HTTP LAN preview works for the UI and editing but cannot exercise installation/offline caching. Load the production app once online before checking offline behavior. Screen wake/auto-lock and kiosk management are device settings; this prototype does not control them. Start with landscape orientation on the iPad Air and keep browser zoom at 100%.

## Cloudflare Workers deployment

`wrangler.jsonc` defines a **static-assets Worker**, named `family-dashboard`, serving `dist/` with SPA fallback. No Worker API, D1 binding, paid service, or secrets are required at this stage. This follows [Cloudflare's static SPA configuration](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/). Check your account's current limits before enabling future services.

To deploy manually:

```sh
pnpm exec wrangler login
pnpm deploy:check
pnpm deploy
```

Wrangler prints the `workers.dev` URL after a successful deployment. Authenticate with your own Cloudflare account; no credentials belong in this repository. If a Worker named `family-dashboard` already exists in your account, select an unused `name` in `wrangler.jsonc` before deploying.

For Git-connected Workers Builds, connect `JasonJohnson2/family-dashboard`, select the deployment branch, and use:

| Setting                           | Value                            |
| --------------------------------- | -------------------------------- |
| Root directory                    | Repository root                  |
| Install command (if configurable) | `pnpm install --frozen-lockfile` |
| Build command                     | `pnpm build`                     |
| Deploy command                    | `pnpm exec wrangler deploy`      |
| Node version                      | 24                               |

The checked-in lockfile identifies pnpm. Use pnpm 11 if the build environment asks for a package-manager version. Cloudflare Pages could also serve the resulting `dist/` folder, but Workers is the configured and validated deployment target. Nothing is automatically published by this repository's test workflow.

## Code and data model

```text
src/
  App.tsx                    Navigation, layout, section routing
  store.tsx                  Shared in-memory household state
  types.ts                   Provider-independent domain models
  data/
    mock.ts                  Relative-date fixtures and family defaults
    calendarProvider.ts      Transport-neutral provider contract; mock adapter
  lib/
    dates.ts                 Local dates and recurrence expansion
    id.ts                    IDs that also work during HTTP LAN testing
  components/
    Home.tsx                 Mockup-inspired dashboard
    Calendar.tsx             Calendar views
    Sections.tsx             Chores, meals, and lists screens
    Editors.tsx              Creation/edit dialogs and event details
    QuickList.tsx            Reusable shared-list controls
    ui.tsx                   Cards, avatars, filters, rows, dialog shell
    AppUpdate.tsx            Service-worker update prompt
  styles.css                 Responsive layout and design tokens
tests/                       Browser interaction checks
public/                      Local artwork, app icons, response headers
wrangler.jsonc               Cloudflare Workers static-assets configuration
```

Events reference `CalendarSource` and member IDs, not a provider-specific payload. `sourceId` and optional `externalId` allow a future adapter to map remote identities. Provider kinds reserve `icloud`, `google`, `local`, and `mock`; only local/mock data is currently used. `CalendarProvider` describes a read boundary; the mock adapter returns recurrence masters, not remotely expanded occurrences. The app currently seeds those same fixtures directly into its shared state.

Recurrence supports none/daily/weekdays/weekly/monthly. Monthly events on the 29th–31st skip months without that date. There is no full RFC 5545 RRULE parser, exceptions, cross-timezone conversion, or overnight event editor yet. Events carry a timezone for later normalization. Daily/weekly recurrence preserves local wall-clock time rather than adding fixed UTC milliseconds. An occurrence's ID combines its event ID and local date. Chore completion uses due-date keys so completing today does not complete tomorrow.

Meal plans contain an optional `recipeId`; `Recipe` reserves structured ingredients and instructions. Shared-list items may reference recipes later. No recipe UI or grocery generation is implemented.

## Next decisions, together

After reviewing the UI on the iPad, agree on persistence and access control before adding a Workers API and D1 migrations. Separately decide the Apple/iCloud integration method, credentials, sync direction, timezone handling, recurrence exceptions, and conflict behavior. **No iCloud/CalDAV synchronization method has been selected or implemented.** Google/work calendars can later use the same event boundary. Recipes, grocery generation, live weather, and kiosk conveniences are later milestones, not hidden dependencies of this prototype.

## Assets

Landscape photograph: [Unsplash source](https://images.unsplash.com/photo-1470770841072-f978cf4d019e), bundled locally; [Unsplash license](https://unsplash.com/license). DM Sans and Lora are bundled via Fontsource under their included SIL Open Font Licenses. Icons use Lucide (ISC). The app/home-screen icon is an original SVG included in this repository.
