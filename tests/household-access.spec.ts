import { test, expect } from './fixtures';
import { loginHousehold, testCredential } from './access-fixture';

test.setTimeout(60_000);
test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
});
test('public shell never loads household data before login; trusted cookie survives reopening', async ({
  page,
  context,
  browser,
  browserName,
  request,
}) => {
  const privateRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/household')) privateRequests.push(r.url());
  });
  await page.goto('/#calendar');
  await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
  await expect(page.getByLabel('Household access credential')).toBeVisible();
  expect(privateRequests).toHaveLength(0);
  expect((await request.get('/api/household')).status()).toBe(401);
  await page.getByLabel('Household access credential').fill('wrong-credential');
  await page.getByRole('button', { name: 'Enter dashboard' }).click();
  await expect(page.getByRole('alert')).toContainText('not accepted');
  await page.getByLabel('Household access credential').fill(testCredential);
  await page.getByRole('checkbox', { name: 'Trust this device' }).check();
  await page.getByLabel('Device name').fill('Kitchen iPad');
  const loginResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/auth/login'),
  );
  await page.getByRole('button', { name: 'Enter dashboard' }).click();
  const setCookie = await (await loginResponse).headerValue('set-cookie');
  expect(setCookie).toContain('SameSite=Lax');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Max-Age=15552000');
  await expect(page.getByRole('heading', { name: 'Family calendar', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).not.toContain('household');
  const cookie = (await context.cookies()).find((c) => c.name === 'household_local')!;
  expect(cookie.httpOnly).toBe(true);
  // Windows WebKit reports None through its cookie inspection protocol even when
  // the HTTP response sets Lax. Assert the actual header above on every browser.
  if (browserName !== 'webkit' || process.platform !== 'win32') expect(cookie.sameSite).toBe('Lax');
  expect(cookie.expires * 1000 - Date.now()).toBeGreaterThan(179 * 86400000);
  const reopened = await browser.newContext({ storageState: await context.storageState() });
  try {
    const next = await reopened.newPage();
    await next.goto('http://localhost:4173/#lists');
    await expect(next.getByRole('checkbox', { name: 'Milk', exact: true })).toBeVisible();
    await expect(next.getByLabel('Household access credential')).toHaveCount(0);
  } finally {
    await reopened.close();
  }
});
test('locking deliberately clears household state and cookies, including cached PWA startup', async ({
  page,
  request,
  context,
}) => {
  await loginHousehold(request);
  await page.goto('/#lists');
  await expect(page.getByRole('checkbox', { name: 'Milk', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Household privacy', exact: true }).last().click();
  await page.getByRole('button', { name: 'Lock this device', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm security change', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Milk', exact: true })).toHaveCount(0);
  expect((await request.get('/api/household')).status()).toBe(401);
  expect((await context.cookies()).some((c) => c.name === 'household_local')).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (
      await Promise.all(
        keys.map(async (key) => (await (await caches.open(key)).keys()).map((r) => r.url)),
      )
    ).flat();
  });
  expect(cached.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);
});
test('operator can revoke another device; returning device shows access screen', async ({
  page,
  request,
  browser,
}) => {
  await loginHousehold(request, true, 'Owner computer');
  const other = await browser.newContext({ baseURL: 'http://localhost:4173' });
  try {
    await loginHousehold(other.request, true, 'Kitchen tablet');
    const tablet = await other.newPage();
    await tablet.goto('/#lists');
    await expect(tablet.getByRole('checkbox', { name: 'Milk', exact: true })).toBeVisible();
    await page.goto('/');
    await page.getByRole('button', { name: 'Household privacy', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Trusted devices & browsers' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Unlock operator controls' }).click();
    await page.getByLabel('Operator PIN', { exact: true }).fill('test-only-48269173');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke Kitchen tablet' }).click();
    await page.getByRole('button', { name: 'Confirm security change', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Revoke Kitchen tablet' })).toHaveCount(0);
    await tablet.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(tablet.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
    await expect(tablet.getByRole('checkbox', { name: 'Milk', exact: true })).toHaveCount(0);
    expect((await other.request.get('/api/household')).status()).toBe(401);
  } finally {
    await other.close();
  }
});
test('credential change requires PIN and confirmation and signs out every device', async ({
  page,
  request,
}) => {
  await loginHousehold(request);
  await page.goto('/');
  await expect(page.getByText('Household up to date', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Household privacy', exact: true }).last().click();
  await page.getByRole('button', { name: 'Unlock operator controls' }).click();
  await page.getByLabel('Operator PIN', { exact: true }).fill('test-only-48269173');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  const next = 'next-test-household-passphrase-129874';
  await page.getByLabel('New household credential', { exact: true }).fill(next);
  await page.getByLabel('Confirm new credential').fill(next);
  await page.getByRole('button', { name: 'Review credential change' }).click();
  await page.getByRole('button', { name: 'Confirm security change', exact: true }).click();
  await expect(page.getByLabel('Household access credential')).toBeVisible();
  await page.getByLabel('Household access credential').fill(next);
  await page.getByRole('button', { name: 'Enter dashboard' }).click();
  await expect(page.getByRole('button', { name: 'Manage family members' })).toBeVisible();
});
test('access screen and security settings fit desktop, tablet and phone', async ({
  page,
  request,
}, info) => {
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['landscape', 1180, 820],
    ['portrait', 820, 1180],
    ['phone', 390, 844],
    ['narrow', 320, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`access-${name}.png`), fullPage: true });
  }
  await loginHousehold(request);
  await page.reload();
  await page.getByRole('button', { name: 'Household privacy', exact: true }).last().click();
  expect(await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('privacy-narrow.png'), fullPage: true });
});
