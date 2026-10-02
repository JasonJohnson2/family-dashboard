import { test, expect } from './fixtures';
import { loginHousehold } from './access-fixture';
import type { HouseholdState } from '../src/data/contracts';
test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);

for (const mode of ['connected', 'reconnect', 'new'] as const)
  test(`Google management ${mode} uses normal controls and preserves other data`, async ({
    page,
    request,
  }, info) => {
    expect((await request.post('/__test/reset')).ok()).toBe(true);
    await loginHousehold(request);
    const household: HouseholdState = await (await request.get('/api/household')).json();
    const original = structuredClone(household);
    let connected = mode !== 'new',
      requiresReconnect = mode === 'reconnect',
      failure: string | null =
        mode === 'connected' ? 'unavailable' : mode === 'reconnect' ? 'authorization' : null;
    let operator = '',
      mutations = 0,
      syncs = 0,
      discovery = 0,
      failSave = false;
    let calendar = {
      sourceId: 'google_browser',
      name: 'Household Google plans',
      enabled: mode !== 'new',
      privacyMode: 'title',
      memberId: household.family[1].id as string | null,
      color: '#123456',
      lastSyncedAt: '2026-09-21T12:00:00Z',
      lastFailure: null,
    };
    const health = () => ({
      connected,
      requiresReconnect,
      lastFailure: failure,
      needsAttention: !!failure,
      enabledCalendars: connected ? 1 : 0,
      lastSyncedAt: calendar.lastSyncedAt,
    });
    await page.route('**/api/rewards/operator', async (route) => {
      const response = await route.fetch();
      operator = (await response.json()).token;
      await route.fulfill({ response });
    });
    await page.route('**/api/calendar/refresh', (route) => {
      expect(route.request().method()).toBe('GET');
      return route.fulfill({
        json: {
          providers: { google: { status: health() }, icloud: { status: { connected: true } } },
        },
      });
    });
    await page.route('**/api/icloud/status', (route) =>
      route.fulfill({
        json: {
          configured: true,
          connected: true,
          account: 'fixture@icloud.test',
          calendars: [],
          sync: { requiresReconnect: false, needsAttention: false },
        },
      }),
    );
    await page.route('**/api/google/**', async (route) => {
      expect(route.request().headers()['x-reward-operator']).toBe(operator);
      expect(route.request().headers().authorization).toBeUndefined();
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/status'))
        return route.fulfill({
          json: {
            configured: true,
            connected,
            email: connected ? 'fixture@google.test' : null,
            calendars: connected ? [calendar] : [],
            sync: health(),
          },
        });
      mutations++;
      if (path.endsWith('/connect') || path.endsWith('/reconnect'))
        return route.fulfill({
          json: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fixture=read-only',
          },
        });
      if (path.endsWith('/refresh')) {
        expect(route.request().postDataJSON()).toEqual({ manual: true });
        syncs++;
        failure = null;
        return route.fulfill({ json: { outcome: 'complete', synced: 1, status: health() } });
      }
      if (path.endsWith('/disconnect')) {
        connected = false;
        return route.fulfill({ json: { connected: false } });
      }
      if (route.request().method() === 'PATCH') {
        if (failSave)
          return route.fulfill({
            status: 503,
            json: { error: 'Calendar could not be saved. Retry.' },
          });
        calendar = { ...calendar, ...route.request().postDataJSON() };
        return route.fulfill({ json: { calendar } });
      }
      discovery++;
      return route.fulfill({ json: { calendars: [calendar] } });
    });
    // OAuth navigation is intercepted, never contacts real Google. Backend tests verify real state/PKCE/cookie handling.
    await page.route('https://accounts.google.com/**', (route) => {
      connected = true;
      requiresReconnect = false;
      failure = null;
      return route.fulfill({
        contentType: 'text/html',
        body: `<script>location.replace('http://localhost:4173/#connections?google=${mode === 'new' ? 'connected' : 'reconnected'}')</script>`,
      });
    });
    await page.goto('/#home');
    if (info.project.name === 'phone-webkit')
      await page.getByRole('button', { name: 'More navigation' }).click();
    await page
      .getByRole('button', { name: 'Settings', exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole('button', { name: 'Calendar Connections', exact: true }).click();
    const google = page.getByRole('region', { name: 'Google Calendar connection' });
    expect(mutations).toBe(0);
    await expect(
      google.getByRole('button', { name: 'Disconnect Google Calendar', exact: true }),
    ).toHaveCount(0);
    const unlock = async () => {
      await page.getByRole('button', { name: 'Unlock operator controls' }).click();
      await page.getByLabel('Operator PIN', { exact: true }).fill('test-only-48269173');
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    };
    await unlock();
    if (mode !== 'connected') {
      await google
        .getByRole('button', {
          name: mode === 'new' ? 'Connect Google Calendar' : 'Reconnect Google Calendar',
          exact: true,
        })
        .click();
      await expect(page.getByRole('dialog', { name: 'Calendar connections' })).toBeVisible();
      await expect(
        page.getByText(
          mode === 'new'
            ? 'Google connected. Unlock controls'
            : 'Google reconnected. Your calendar settings',
          { exact: false },
        ),
      ).toBeVisible();
      await unlock();
      expect(calendar.memberId).toBe(original.family[1].id);
      expect(calendar.privacyMode).toBe('title');
      expect(calendar.enabled).toBe(mode !== 'new');
    } else {
      await expect(google.getByText('Temporarily unavailable', { exact: true })).toBeVisible();
      await expect(
        google.getByRole('button', { name: 'Reconnect Google Calendar', exact: true }),
      ).toHaveCount(0);
    }
    await expect(google.getByLabel('Assigned to')).toHaveValue(original.family[1].id);
    expect(discovery).toBe(0);
    expect(syncs).toBe(0);
    await google.getByRole('button', { name: 'Discover Google calendars' }).click();
    await expect.poll(() => discovery).toBe(1);
    const form = google.locator('.external-calendar-settings');
    if (mode === 'new') await form.getByLabel('Show on dashboard').check();
    await form.getByLabel('Assigned to').selectOption(original.family[0].id);
    await form.getByLabel('Privacy', { exact: true }).selectOption('busy');
    failSave = true;
    await form.getByRole('button', { name: 'Save calendar' }).click();
    await expect(google.getByRole('alert')).toContainText('Calendar could not be saved');
    await expect(form.getByLabel('Privacy', { exact: true })).toHaveValue('busy');
    expect(calendar.privacyMode).toBe('title');
    failSave = false;
    await form.getByRole('button', { name: 'Save calendar' }).click();
    await expect(google.getByText('Calendar settings saved.', { exact: false })).toBeVisible();
    expect(syncs).toBe(0);
    expect(calendar.memberId).toBe(original.family[0].id);
    expect(calendar.privacyMode).toBe('busy');
    await google.getByRole('button', { name: 'Sync Now', exact: true }).click();
    await expect(google.getByText('Google Calendar updated.', { exact: true })).toBeVisible();
    await expect(google.getByRole('button', { name: 'Sync Now', exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`google-${mode}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const bounds = await google
      .getByRole('button', { name: 'Sync Now', exact: true })
      .boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await google.getByRole('button', { name: 'Disconnect Google Calendar', exact: true }).click();
    await expect(google.getByText('Google events imported', { exact: false })).toBeVisible();
    await google.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(connected).toBe(true);
    await google.getByRole('button', { name: 'Disconnect Google Calendar', exact: true }).click();
    await google.getByRole('button', { name: 'Confirm Google disconnect' }).click();
    await expect(
      google.getByRole('button', { name: 'Connect Google Calendar', exact: true }),
    ).toBeVisible();
    expect(await (await request.get('/api/household')).json()).toEqual(original);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('test-only-48269173');
  });

test('OAuth errors return to connections safely and Settings is accessible on a portrait tablet', async ({
  page,
  request,
}) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  await loginHousehold(request);
  let reads = 0,
    closed = false;
  await page.route('**/api/calendar/refresh', (route) => {
    reads++;
    if (!closed) expect(route.request().method()).toBe('GET');
    return route.fulfill({
      json: {
        providers: {
          google: { status: { connected: false } },
          icloud: { status: { connected: false } },
        },
      },
    });
  });
  await page.goto('/#connections?google_error=google_denied');
  await expect(page.getByRole('dialog', { name: 'Calendar connections' })).toBeVisible();
  await expect(page.getByText('Google access was not granted.', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/#connections$/);
  closed = true;
  await page.getByRole('button', { name: 'Close dialog' }).click();
  // Closing returns to Calendar, which has its ordinary stale-check behavior.
  await page.unroute('**/api/calendar/refresh');
  await page.setViewportSize({ width: 820, height: 1180 });
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  expect(reads).toBeGreaterThan(0);
});
