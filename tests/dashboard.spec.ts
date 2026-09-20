import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__test/reset');
  expect(response.ok()).toBe(true);
});
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await expect(page.getByText('Saving�', { exact: true })).toHaveCount(0);
});

test('five sections fit the screen and navigation works', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  for (const name of ['Home', 'Calendar', 'Chores', 'Meals', 'Lists']) {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name, exact: true })
      .click();
    await expect(page).toHaveTitle(`${name} · Our Home`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(errors).toEqual([]);
});

test('chore completion is shared with Home and repeats independently tomorrow', async ({
  page,
}) => {
  await page.goto('/#home');
  await page.getByRole('checkbox', { name: 'Feed the dog Liam' }).check();
  await page.getByRole('navigation').getByRole('link', { name: 'Chores' }).click();
  await expect(page.getByRole('checkbox', { name: /Feed the dog/ })).toBeChecked();
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Feed the dog/ })).not.toBeChecked();
});

test('create a weekly event with a family assignment and view its recurrence', async ({ page }) => {
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Event name').fill('Weekly family walk');
  await dialog.getByRole('button', { name: 'Mia', exact: false }).click();
  await dialog.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  await dialog.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: /Weekly family walk/ })).toBeVisible();
  await page.getByRole('button', { name: 'Jason', exact: true }).click();
  await expect(page.getByRole('button', { name: /Weekly family walk/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mia', exact: true }).click();
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await page.getByRole('button', { name: /Weekly family walk/ }).click();
  await expect(dialog).toContainText('Repeats weekly');
  await expect(dialog).toContainText('Mia');
  await dialog.getByRole('button', { name: 'Lovely, got it' }).click();
  await page.getByRole('button', { name: 'month', exact: true }).click();
  await expect(page.locator('.calendar-cell')).toHaveCount(42);
  await page.getByRole('button', { name: 'day', exact: true }).click();
  await expect(page.locator('.day-agenda')).toBeVisible();
});

test('add, check and remove a list item; create a shared list', async ({ page }) => {
  await page.goto('/#lists');
  await page.getByRole('textbox', { name: 'New list item' }).fill('Strawberries');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Strawberries' }).check();
  await expect(page.getByRole('checkbox', { name: 'Strawberries' })).toBeChecked();
  await page.getByRole('button', { name: 'Remove Strawberries' }).click();
  await expect(page.getByRole('checkbox', { name: 'Strawberries' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByRole('dialog').getByLabel('List name').fill('Weekend');
  await page.getByRole('button', { name: 'Create list' }).click();
  await page.getByRole('button', { name: 'Weekend' }).click();
  await expect(page.getByText('A fresh list. Add something below.')).toBeVisible();
});

test('edit a meal and update family names', async ({ page }) => {
  await page.goto('/#meals');
  await page.getByRole('button', { name: 'Plan a meal' }).click();
  await page.getByRole('dialog').getByLabel('What’s for dinner?').fill('Lemon chicken');
  await page.getByRole('button', { name: 'Save meal' }).click();
  await expect(page.getByRole('heading', { name: 'Lemon chicken' })).toBeVisible();
  await page.getByRole('button', { name: 'Manage family members' }).click();
  await page.getByLabel('Member 1 name').fill('Jamie');
  await page.getByRole('button', { name: 'Save family' }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Chores' }).click();
  await expect(page.getByRole('button', { name: 'Jamie', exact: true })).toBeVisible();
});

test('time validation, modal keyboard handling and refresh persistence', async ({ page }) => {
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Event name').fill('Invalid times');
  await dialog.getByLabel('Ends', { exact: true }).fill('08:00');
  await dialog.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose an end time after the start time.');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.goto('/#lists');
  await page.getByRole('textbox', { name: 'New list item' }).fill('Persistent household item');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'New list item' })).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Persistent household item' })).toBeVisible();
});

test('create a recurring chore with assignment', async ({ page }) => {
  await page.goto('/#chores');
  await page.getByRole('button', { name: 'Add chore', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What needs doing?').fill('Put away laundry');
  await dialog.getByRole('button', { name: /Kelly/ }).click();
  await dialog.getByRole('combobox', { name: 'Repeat' }).selectOption('daily');
  await dialog.getByRole('button', { name: 'Add chore', exact: true }).click();
  await page.getByRole('checkbox', { name: /Put away laundry/ }).check();
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Put away laundry/ })).not.toBeChecked();
});

test('LAN-compatible IDs work without randomUUID', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }),
  );
  await page.goto('/#lists');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.getByRole('textbox', { name: 'New list item' }).fill('Added without randomUUID');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Added without randomUUID' })).toBeVisible();
});

test('production shell reloads offline', async ({ page, context, browserName }) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit on Windows errors internally on offline navigation; verify on physical iPad.',
  );
  await page.goto('/#lists');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.getByRole('textbox', { name: 'New list item' }).fill('Temporary offline item');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'New list item' })).toHaveValue('');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Could not reach');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('checkbox', { name: 'Temporary offline item' })).toBeVisible();
});
