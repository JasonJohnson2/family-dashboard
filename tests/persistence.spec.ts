import { test, expect } from '@playwright/test';

// Network-failure injection must bypass service-worker-owned requests in WebKit.
test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
});

test('a new device loads saved data and an existing device refetches on return', async ({
  page,
  browser,
}) => {
  await page.goto('/#lists');
  const context = await browser.newContext();
  const second = await context.newPage();
  try {
    await second.goto('http://localhost:4173/#lists');
    await expect(second.getByRole('checkbox', { name: 'Milk', exact: true })).not.toBeChecked();
    await page.getByRole('checkbox', { name: 'Milk', exact: true }).check();
    await expect(page.getByText('Household up to date', { exact: true })).toBeVisible();
    await second.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(second.getByRole('checkbox', { name: 'Milk', exact: true })).toBeChecked();
    await second.reload();
    await expect(second.getByRole('checkbox', { name: 'Milk', exact: true })).toBeChecked();
  } finally {
    await context.close();
  }
});

test('failed item save keeps typed text, rolls back and can retry without duplicates', async ({
  page,
}) => {
  await page.goto('/#lists');
  await page.route('**/api/mutations', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Connection interrupted', code: 'unavailable' }),
    }),
  );
  await page.getByRole('textbox', { name: 'New list item' }).fill('Keep my shopping note');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Connection interrupted');
  await expect(page.getByRole('checkbox', { name: 'Keep my shopping note' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'New list item' })).toHaveValue(
    'Keep my shopping note',
  );
  await page.unroute('**/api/mutations');
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByRole('checkbox', { name: 'Keep my shopping note' })).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Household up to date', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Keep my shopping note' })).toHaveCount(1);
});

test('failed checkbox save reverts the check and announces the error', async ({ page }) => {
  await page.goto('/#lists');
  await page.route('**/api/mutations', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Save unavailable', code: 'unavailable' }),
    }),
  );
  await page.getByRole('checkbox', { name: 'Milk', exact: true }).check();
  await expect(page.getByRole('alert')).toContainText('Save unavailable');
  await expect(page.getByRole('checkbox', { name: 'Milk', exact: true })).not.toBeChecked();
});

test('failed event form stays open and saving again recovers without duplicate events', async ({
  page,
}) => {
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Event name').fill('Keep this family plan');
  await page.route('**/api/mutations', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Temporary outage', code: 'unavailable' }),
    }),
  );
  await dialog.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your entries are still here');
  await expect(dialog.getByLabel('Event name')).toHaveValue('Keep this family plan');
  await page.unroute('**/api/mutations');
  await dialog.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /Keep this family plan/ })).toHaveCount(1);
});
