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

test('visible-page polling requests catch-up again without blocking the existing household', async ({
  page,
  request,
}) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  await page.clock.install();
  let refreshes = 0;
  await page.route('**/api/google/refresh', (route) => {
    refreshes++;
    return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
  });
  await page.goto('/#calendar');
  await expect(page.getByRole('heading', { name: 'Family calendar' })).toBeVisible();
  await expect.poll(() => refreshes).toBe(1);
  await page.clock.fastForward(60_000);
  await expect.poll(() => refreshes).toBe(2);
  await expect(page.getByRole('heading', { name: 'Family calendar' })).toBeVisible();
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
