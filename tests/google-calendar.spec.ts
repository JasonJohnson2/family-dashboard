import { test, expect } from '@playwright/test';
import type { HouseholdState } from '../src/data/contracts';

test.use({ serviceWorkers: 'block' });

test('automatic refresh leaves the dashboard usable while Google is slow and displays completed imports', async ({
  page,
  request,
}) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  const state: HouseholdState = await (await request.get('/api/household')).json();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshes = 0;
  await page.route('**/api/household', (route) => route.fulfill({ json: state }));
  await page.route('**/api/google/refresh', async (route) => {
    refreshes++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().postDataJSON()).toEqual({});
    await pending;
    state.sources.push({
      id: 'google_auto',
      name: 'Google calendar',
      provider: 'google',
      color: '#4285f4',
    });
    state.events.push({
      id: 'g_auto',
      sourceId: 'google_auto',
      externalId: 'auto',
      title: 'Automatically imported plan',
      date: state.events[0].date,
      allDay: true,
      timeZone: state.household.timeZone,
      memberIds: [state.family[1].id],
      recurrence: { frequency: 'none' },
    });
    state.household.revision++;
    await route.fulfill({ json: { outcome: 'complete', synced: 1 } });
  });
  try {
    await page.goto('/#calendar');
    await expect(page.getByRole('heading', { name: 'Family calendar' })).toBeVisible();
    await expect.poll(() => refreshes).toBe(1);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    expect(refreshes).toBe(1);
    await expect(
      page.getByRole('button', { name: 'All day Automatically imported plan', exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    page.getByRole('button', { name: 'All day Automatically imported plan', exact: true }),
  ).toBeVisible();
});

test('Google checks are Calendar-only and do not poll every minute', async ({ page, request }) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  await page.clock.install();
  let refreshes = 0;
  await page.route('**/api/google/refresh', (route) => {
    refreshes++;
    return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
  });
  await page.goto('/#home');
  await expect(page.getByRole('heading', { name: /Today's chores/ })).toBeVisible();
  expect(refreshes).toBe(0);
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Family calendar' })).toBeVisible();
  await expect.poll(() => refreshes).toBe(1);
  await page.clock.fastForward(60_000);
  expect(refreshes).toBe(1);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.clock.fastForward(3_600_000);
  expect(refreshes).toBe(1);
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect.poll(() => refreshes).toBe(2);
  await expect(page.getByRole('heading', { name: 'Family calendar' })).toBeVisible();
});

test('Sync calendars bypasses freshness, prevents overlapping clicks and shows errors without losing cached events', async ({
  page,
  request,
}) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  const state: HouseholdState = await (await request.get('/api/household')).json();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let manual = 0;
  await page.route('**/api/household', (route) => route.fulfill({ json: state }));
  await page.route('**/api/google/refresh', async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    if (!route.request().postDataJSON().manual)
      return route.fulfill({
        json: { outcome: 'complete', synced: 0, status: { stale: false, enabledCalendars: 1 } },
      });
    manual++;
    if (manual > 1)
      return route.fulfill({
        json: { outcome: 'complete', synced: 0, status: { needsAttention: true } },
      });
    await pending;
    state.sources.push({
      id: 'google_manual',
      name: 'Google calendar',
      provider: 'google',
      color: '#4285f4',
    });
    state.events.push({
      id: 'g_manual',
      sourceId: 'google_manual',
      externalId: 'manual',
      title: 'Manually synced plan',
      date: state.events[0].date,
      allDay: true,
      timeZone: state.household.timeZone,
      memberIds: [state.family[1].id],
      recurrence: { frequency: 'none' },
    });
    state.household.revision++;
    await route.fulfill({
      json: { outcome: 'complete', synced: 1, status: { enabledCalendars: 1 } },
    });
  });
  await page.goto('/#calendar');
  const button = page.getByRole('button', { name: 'Sync calendars', exact: true });
  await expect(button).toBeEnabled();
  try {
    await button.click();
    await expect(page.getByRole('button', { name: 'Syncing...', exact: true })).toBeDisabled();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    expect(manual).toBe(1);
  } finally {
    release();
  }
  const imported = page.getByRole('button', { name: 'All day Manually synced plan', exact: true });
  await expect(imported).toBeVisible();
  await expect(page.getByText('Updated just now', { exact: true })).toBeVisible();
  await button.click();
  await expect(
    page.getByText(
      'Could not sync all calendars. Saved events are still available. Try again later.',
    ),
  ).toBeVisible();
  await expect(imported).toBeVisible();
});

test('Google projections use the assigned member color, filter and identity while staying read only', async ({
  page,
  request,
}) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  const state: HouseholdState = await (await request.get('/api/household')).json();
  const member = state.family[1],
    other = state.family[0];
  // The Worker/D1 tests cover ingestion. Here exercise the existing UI with its normalized API contract.
  state.sources.push({
    id: 'google_fixture',
    name: 'Google calendar',
    provider: 'google',
    color: '#4285f4',
  });
  state.events = [
    {
      id: 'g_fixture',
      sourceId: 'google_fixture',
      externalId: 'google-occurrence',
      title: 'Busy',
      date: state.events[0].date,
      allDay: true,
      timeZone: state.household.timeZone,
      memberIds: [member.id],
      recurrence: { frequency: 'none' },
    },
  ];
  await page.route('**/api/household', (route) => route.fulfill({ json: state }));
  await page.goto('/#calendar');
  const event = page.getByRole('button', { name: 'All day Busy', exact: true });
  await expect(event).toBeVisible();
  await expect(event).toHaveCSS('--member-color', member.color);
  const filters = page.getByLabel('Filter by family member');
  await filters.getByRole('button', { name: other.name, exact: true }).click();
  await expect(event).toHaveCount(0);
  await filters.getByRole('button', { name: member.name, exact: true }).click();
  await event.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(member.name);
  await expect(dialog).not.toContainText(other.name);
  await expect(dialog.getByRole('button', { name: 'Edit event', exact: true })).toHaveCount(0);
});
