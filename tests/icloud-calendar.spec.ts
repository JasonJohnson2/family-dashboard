import { test, expect } from './fixtures';
import { loginHousehold } from './access-fixture';
import type { HouseholdState } from '../src/data/contracts';
test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);
test('operator connects iCloud, selects privacy/member mapping, sees shared read-only plans and disconnects safely', async ({
  page,
  request,
}, info) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  await loginHousehold(request);
  const household: HouseholdState = await (await request.get('/api/household')).json();
  const original = structuredClone(household);
  let connected = false;
  let configured = false;
  let operator = '';
  let calendar = {
    sourceId: 'icloud_browser',
    name: 'Family & Friends',
    enabled: false,
    privacyMode: 'busy',
    memberId: null as string | null,
    color: '#aabbcc',
    lastSyncedAt: null as string | null,
    lastFailure: null,
  };
  await page.route('**/api/rewards/operator', async (route) => {
    const response = await route.fetch();
    operator = (await response.json()).token;
    await route.fulfill({ response });
  });
  await page.route('**/api/household', (route) => route.fulfill({ json: household }));
  await page.route('**/api/calendar/refresh', (route) => {
    const synced = route.request().method() === 'POST' && configured ? 1 : 0;
    if (synced) {
      household.sources = original.sources.concat({
        id: calendar.sourceId,
        name: calendar.privacyMode === 'busy' ? 'iCloud calendar' : calendar.name,
        color: calendar.color,
        provider: 'icloud',
      });
      household.events = original.events.concat({
        id: 'i_browser',
        sourceId: calendar.sourceId,
        externalId: 'safe-id',
        date: household.events[0].date,
        title: calendar.privacyMode === 'busy' ? 'Busy' : 'iCloud family plan',
        allDay: true,
        timeZone: household.household.timeZone,
        memberIds: calendar.memberId ? [calendar.memberId] : [],
        recurrence: { frequency: 'none' },
        ...(calendar.privacyMode === 'full'
          ? { location: 'Picnic park', notes: 'Bring sandwiches' }
          : {}),
      });
      household.household.revision++;
      calendar.lastSyncedAt = new Date().toISOString();
    }
    return route.fulfill({
      json: {
        outcome: 'complete',
        synced,
        status: { enabledCalendars: configured ? 1 : 0, needsAttention: false },
        providers: {
          google: {
            outcome: 'complete',
            synced: 0,
            status: { connected: true, needsAttention: false },
          },
          icloud: { outcome: 'complete', synced, status: { connected, needsAttention: false } },
        },
      },
    });
  });
  await page.route('**/api/icloud/**', async (route) => {
    expect(route.request().headers()['x-reward-operator']).toBe(operator);
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status'))
      return route.fulfill({
        json: {
          configured: true,
          connected,
          account: connected ? 'fixture@icloud.test' : null,
          calendars: connected ? [calendar] : [],
          sync: { requiresReconnect: false, needsAttention: false },
        },
      });
    if (path.endsWith('/connect')) {
      expect(route.request().postDataJSON()).toEqual({
        account: 'fixture@icloud.test',
        appSpecificPassword: 'abcd-efgh-ijkl-mnop',
      });
      connected = true;
      return route.fulfill({ json: { connected: true, calendars: [calendar] } });
    }
    if (path.endsWith('/calendars') && route.request().method() === 'PATCH') {
      calendar = { ...calendar, ...route.request().postDataJSON() };
      configured = calendar.enabled;
      household.events = original.events;
      household.sources = original.sources;
      return route.fulfill({ json: { calendar } });
    }
    if (path.endsWith('/calendars')) return route.fulfill({ json: { calendars: [calendar] } });
    expect(path).toMatch(/disconnect$/);
    connected = false;
    configured = false;
    household.events = original.events;
    household.sources = original.sources;
    return route.fulfill({ json: { connected: false } });
  });
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'Calendar connections', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Unlock with the household operator PIN');
  await expect(page.getByLabel('Apple Account email')).toHaveCount(0);
  await page.getByRole('button', { name: 'Unlock operator controls' }).click();
  await page.getByLabel('Operator PIN', { exact: true }).fill('test-only-48269173');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByLabel('Apple Account email').fill('fixture@icloud.test');
  await page.getByLabel('App-specific password', { exact: true }).fill('abcd-efgh-ijkl-mnop');
  await page.screenshot({ path: info.outputPath('icloud-connect.png'), fullPage: true });
  await page.getByRole('button', { name: 'Connect iCloud Calendar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'iCloud calendars', exact: true })).toBeVisible();
  await expect(page.getByLabel('Show on dashboard')).not.toBeChecked();
  const settings = page.locator('.external-calendar-settings');
  await settings.getByLabel('Show on dashboard').check();
  await settings.getByLabel('Assigned to').selectOption(household.family[1].id);
  await settings.getByLabel('Privacy', { exact: true }).selectOption('full');
  await settings.getByRole('button', { name: 'Save calendar' }).click();
  await expect(
    page.getByRole('dialog').getByText('Updated just now', { exact: true }),
  ).toBeVisible();
  expect(calendar.memberId).toBe(household.family[1].id);
  await page.screenshot({ path: info.outputPath('icloud-settings.png'), fullPage: true });
  const viewport = page.viewportSize();
  for (const [width, height] of [
    [1440, 1000],
    [1180, 820],
    [820, 1180],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(settings.getByLabel('Assigned to')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`icloud-settings-${width}.png`),
      fullPage: true,
    });
    if (width === 390) {
      await settings.getByRole('button', { name: 'Save calendar' }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath('icloud-settings-phone-controls.png'),
        fullPage: true,
      });
    }
  }
  if (viewport) await page.setViewportSize(viewport);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'All day iCloud family plan', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Picnic park');
  await expect(page.getByRole('dialog')).toContainText(household.family[1].name);
  await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('icloud-read-only.png'), fullPage: true });
  await page.getByRole('button', { name: 'Lovely, got it' }).click();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('.main-content')).toContainText('iCloud family plan');
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Calendar connections', exact: true }).click();
  await page.getByRole('button', { name: 'Update app-specific password' }).click();
  await expect(page.getByLabel('App-specific password', { exact: true })).toHaveValue('');
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain('abcd-efgh-ijkl-mnop');
  await page.getByRole('button', { name: 'Update app-specific password' }).click();
  await page.getByRole('button', { name: 'Disconnect iCloud Calendar', exact: true }).click();
  await expect(
    page.getByText('This removes the saved iCloud credential', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep connected' }).click();
  expect(connected).toBe(true);
  await page.getByRole('button', { name: 'Disconnect iCloud Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm disconnect' }).click();
  await expect(
    page.getByRole('button', { name: 'Connect iCloud Calendar', exact: true }),
  ).toBeVisible();
  expect(connected).toBe(false);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(
    page.getByRole('button', { name: 'All day iCloud family plan', exact: true }),
  ).toHaveCount(0);
  expect(household.events).toEqual(original.events);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('partial provider failure reports iCloud attention while Google and local calendar remain usable', async ({
  page,
  request,
}) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  await loginHousehold(request);
  await page.route('**/api/calendar/refresh', (route) =>
    route.fulfill({
      json: {
        outcome: 'unavailable',
        synced: 1,
        status: { enabledCalendars: 2, needsAttention: true },
        providers: {
          google: { outcome: 'complete', synced: 1, status: { needsAttention: false } },
          icloud: { outcome: 'unavailable', synced: 0, status: { needsAttention: true } },
        },
      },
    }),
  );
  await page.goto('/#calendar');
  await expect(page.getByText('iCloud could not sync.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Family calendar' })).toBeVisible();
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'day', exact: true }).click();
  await expect(page.locator('.day-agenda')).toBeVisible();
});
