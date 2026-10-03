# Local Family Calendar V2

## Storage and compatibility

Migration **0010_local_calendar_v2.sql** creates household-scoped local_event_metadata for server-owned createdAt/updatedAt timestamps and optional reminderMinutes, plus event_exceptions. The existing events table is unchanged, so applying the migration before publishing V2 does not change the old reader’s event row shape. It never changes already-applied migrations. Existing titles, IDs, civil dates/times, timezone, source/external IDs, recurrence JSON, and event_members remain intact. Existing events get migration-time timestamps; optional fields remain absent. No demo records or generated occurrence rows are added.

A local event stores title, date, optional inclusive endDate, allDay, optional startTime/endTime, IANA timeZone, memberIds (empty means Everyone), optional location (160 characters), plain-text notes (2,000 characters), recurrence, timestamps, and optional reminderMinutes (0–40,320). Both adults and children can be assigned. New events use the household timezone, not the browser's timezone. Existing local timezones are preserved.

## Recurrence representation

JSON uses RFC 5545 concepts: frequency (none/daily/weekdays/weekly/monthly/yearly), optional interval (1–999), byWeekday (Sunday=0), monthWeek (first through fifth or -1 for last), and either inclusive until date or count (1–10,000). Weekly intervals use Monday as the recurrence week start, independently of the Sunday-start calendar display. Custom weekdays support multiple days; monthly ordinal weekdays use one weekday. The start date anchors the interval; for a weekday/ordinal pattern, only matching dates on or after the start are included. COUNT counts matching scheduled dates before cancellations/overrides, so cancelling one does not extend the series. Invalid month dates and leap dates are skipped, never shifted to the next month. Weekdays retains the legacy Monday–Friday behavior.

This is a deliberate, validated subset, not a raw RRULE editor or a full iCalendar serializer. BYHOUR, BYMINUTE, arbitrary BYSETPOS, multiple ordinal weekdays, RDATE, and multiple rules are unsupported and rejected instead of silently approximated. They can be added later at the shared data-layer boundary. The concepts are based on [RFC 5545 recurrence rules](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10).

## Expansion and reads

The household snapshot contains compact masters plus exception records. Shared pure functions in src/lib/localCalendar.ts generate ordinary EventOccurrence records for requested calendar days; Home, upcoming events, day/week/month and member filtering all consume those occurrences. They do not interpret recurrence rules separately. Member filtering occurs **after** overrides, so a one-occurrence assignment change is reflected correctly.

Authenticated GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD offers the same server-side projection for a maximum 62-day inclusive window. It validates the range and performs no calendar writes. Server window projections reuse the existing internal calendar Durable Object to avoid the Free Worker 10 ms CPU ceiling for unusually old/long/overlapping series; the normal compact household snapshot and frontend views need no additional Object request. No new class/binding/storage is added. The engine seeks daily/weekly intervals arithmetically rather than scanning every historical day; monthly/yearly count calculations only inspect bounded calendar periods. No infinite set is generated. Local saves accept years 1900–2199 and spans of at most 367 inclusive days. Existing imported single events retain their spans. The app's current compact snapshot transport is retained so browsing a calendar does not require an additional HTTP request per cell.

## Exceptions and scoped commands

A record's key is (household_id, event_id, recurrence_date), where recurrence_date is the original scheduled **start date**, never the clicked continuation day or a moved date. cancelled=true suppresses it; otherwise value is a validated full replacement snapshot. Moving Tuesday to Wednesday suppresses Tuesday and emits Wednesday once. Re-editing uses the same original key and replaces the override. Multi-day continuation cells refer to the same occurrence. Exceptions reference their master with cascading deletion.

The authenticated mutation API accepts event.put, event.edit and event.delete. Scoped commands supply the master id, original recurrenceDate, and scope (this/future/all); edits supply a complete event value, and future edits also supply a newSeriesId generated once by the client. Generic legacy event.put and delete/event commands remain compatible, with the same local-only checks. The Worker validates ownership, stored provider, member IDs, occurrence membership, date/time/recurrence constraints and reserved imported IDs. Revisions, atomic D1 batches and retry receipts remain in force.

- **This event, edit:** upsert one replacement; the master stays in place. Its recurrence does not become a second series. It may move beyond the original recurrence end. The form omits Repeat because the change targets one occurrence.
- **This event, delete:** upsert a cancellation. Deleting an already modified occurrence cancels its original key and removes its moved projection.
- **This and future, edit:** truncate the original master before the selected original date; create a new master beginning at the edited date. If editing the first scheduled date that equals the master start, remove the empty original master. An unchanged COUNT rule carries only its remaining count; choosing a different count/rule is a fresh rule from the split. The new local master clears a legacy externalId to avoid duplicate identities.
- **This and future, delete:** truncate before that date and remove exceptions whose original keys are in the deleted range. Earlier masters/overrides remain, including an earlier override moved to a later visible date.
- **All events, edit:** replace the master while preserving its identity/createdAt. Earlier and later scheduled occurrences change.
- **All events, delete:** remove the master and all of its exceptions/assignments atomically.

Deterministic override policy: title/member/location/notes/reminder-only series edits retain replacement snapshots and cancellations. Replacement snapshots retain their explicit values, rather than inheriting later master detail changes. Changing start/end dates, times, all-day status, timezone or recurrence (including shortening/extending its end) clears exceptions **within the edited scope**, avoiding stale or orphaned occurrence identities. A future split with an unchanged schedule transfers future exceptions to the new master; changed schedules discard future exceptions and always preserve earlier ones. This policy is described in the editor before saving.

Future scope edits the entire remaining selected series, including all weekdays in that series. To change Thursdays independently of Tuesdays, use a separate weekly Thursday series; V2 does not treat weekdays within a series as separate sub-series.

## All-day, multi-day and timezone behavior

Dates are civil Gregorian YYYY-MM-DD values. UTC is used only for date arithmetic, never to pretend an all-day event is midnight UTC. Inclusive all-day end dates match the existing dashboard/import normalization. A vacation Oct 10–15 appears on six days as one master. Continuation days of timed spans show “Continues” instead of repeating their original start time; details retain the complete start/end span. Timed spans ending at midnight exclude the ending day's empty portion. Recurring spans preserve the civil-day distance and local start/end clock times across DST, and overlapping occurrences have distinct identities.

New event saves validate wall-clock times against the event's IANA zone: nonexistent spring-forward times are rejected, and ambiguous autumn times choose the first instant when resolving. Recurrences retain wall-clock times, so 5:30 PM remains 5:30 PM across DST; no UTC instant is persisted as a recurring master. Household Today is calculated in the household timezone. Existing imported instants and provider privacy behavior are preserved. Recurring times inside a future DST gap remain civil-time plans in V2; notification delivery must define/validate an explicit gap policy before scheduling an instant. No reminder is sent by this release.

## UI and recovery

The existing calendar shell/navigation stays intact. Add/Edit offers title, date, all-day, starts/ends, multiple days, member chips and Repeat. Custom patterns and repeat endings unfold only when selected; location, notes and reminder configuration are under a details disclosure. Event details show source/read-only status, span, members, recurrence summary, location and plain-text notes. Local recurring edits/deletes prompt all three scopes; external events expose neither control.

Forms retain drafts on failed saves and lock fields while an uncertain save awaits its exact retry. A recovered retry closes only the form that submitted that save. Concurrent changes to the same master/exception set require reopening to review instead of overwriting. Household-wide revision conflicts still reconcile authoritative state.

## D1 efficiency and security

One series row, member links and only actual exceptions are persisted. No page load materializes occurrences. Saves compare changed masters, assignments and exception rows and use bound SQL with json_each for affected rows; editing one occurrence does not rewrite the household calendar or unchanged exceptions. Tests audit INSERT/UPDATE/DELETE on calendar tables during reads. Existing authentication checks remain unchanged.

Household authentication, trusted devices, same-origin protection and operator restrictions are unchanged. Calendar editing retains current household access; it does not gain operator-only restrictions. Source checks use stored records, not client claims: Google/iCloud projections cannot be edited by submitting sourceId=local. OAuth, secrets, privacy modes, member mappings, external synchronization and the free-tier calendar-sync Durable Object keep their existing behavior; that same Object also handles the validated local read projection.

## Deployment and future reminders

The existing GitHub → Cloudflare pipeline must run pnpm db:migrate:remote before publishing the Worker (the documented existing deploy command already does this). Locally run pnpm db:migrate:local, then pnpm dev. The additive migration needs no new binding, secret, credential or manual reseeding. Do not manually deploy production. Applying the migration alone leaves old event records compatible. After V2 recurrence patterns/exceptions are saved, a functional rollback requires a V2-aware reader and editor. Accept the PWA update or reload open devices after deployment so they use the new event schema and recurrence engine.

reminderMinutes is configuration only. A later authorized notification project can consume the bounded occurrence projection and original recurrence identity, resolve local times with a DST-gap policy, use exception replacements/cancellations, and deduplicate delivery by household/master/original-date/reminder. Delivery permissions, device subscriptions, notification channels, queues/alarms and cancellation of scheduled deliveries remain future work. No notifications, external calendar writes, maps, invitations, sharing or AI creation are implemented.

## Validation

Unit tests cover all presets, intervals, multiple weekdays, ordinal months, end dates/counts, skipped month/leap dates, bounded distant windows, overlapping spans, scoped changes, moves, exception replacement, deletion, count-preserving splits, retained/cleared overrides, DST, midnight and validation. Real D1 tests cover the complete soccer scenario, persistence, timestamp ownership, migration preservation, authenticated reads, member/household/provider boundaries, retries/conflicts and no calendar writes on read. Browser tests cover creation, scopes, moves, deletions, reloads, Home/month/day/filter behavior, escaped notes, existing save-recovery checks and four viewport reviews, alongside the unchanged full application suite.
