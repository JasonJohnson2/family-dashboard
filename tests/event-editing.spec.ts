import { test, expect, type APIRequestContext } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
});
async function household(request: APIRequestContext) {
  return await (await request.get('/api/household')).json();
}
async function update(request: APIRequestContext, value: unknown) {
  const state = await household(request);
  const result = await request.post('/api/mutations', {
    data: {
      id: crypto.randomUUID(),
      revision: state.household.revision,
      operations: [{ type: 'event.put', value }],
    },
  });
  expect(result.ok(), await result.text()).toBe(true);
}

test('edit from Home persists title, times, assignments, location and notes without duplicating', async ({
  page,
  request,
}) => {
  const before = await household(request);
  await page.goto('/#home');
  await page
    .getByRole('button', { name: /Soccer practice/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Event name')).toHaveValue('Soccer practice');
  await expect(dialog.getByLabel('Notes')).toHaveValue('Bring a water bottle and cleats.');
  await dialog.getByLabel('Event name').fill('Soccer at the park');
  await dialog.getByLabel('Starts', { exact: true }).fill('16:00');
  await dialog.getByLabel('Ends', { exact: true }).fill('17:30');
  await dialog.getByLabel('Location').fill('Riverside park');
  await dialog.getByLabel('Notes').fill('Bring the blue ball');
  await dialog.getByRole('button', { name: 'Everyone', exact: true }).click();
  await dialog.getByRole('button', { name: /Mia/ }).click();
  await dialog.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await dialog.getByRole('button', { name: 'Save event' }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: /Soccer at the park/ })
    .first()
    .click();
  await expect(dialog).toContainText('Riverside park');
  await expect(dialog).toContainText('Bring the blue ball');
  const after = await household(request);
  expect(after.events).toHaveLength(before.events.length);
  expect(after.events.find((e: { id: string }) => e.id === 'soccer')).toMatchObject({
    title: 'Soccer at the park',
    startTime: '16:00',
    endTime: '17:30',
    memberIds: ['mia'],
    recurrence: { frequency: 'daily' },
  });
});

test('editing a later occurrence preserves the series start, identity, timezone and repeat end', async ({
  page,
  request,
}) => {
  const state = await household(request);
  const original = state.events.find((e: { id: string }) => e.id === 'soccer');
  const until = '2099-12-31';
  await update(request, {
    ...original,
    timeZone: 'Europe/London',
    externalId: 'local-legacy-id',
    recurrence: { frequency: 'weekly', until },
  });
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await page.getByRole('button', { name: /Soccer practice/ }).click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('whole repeating series');
  await expect(dialog.getByLabel('Series start date')).toHaveValue(original.date);
  await expect(dialog.getByLabel('Repeat until')).toHaveValue(until);
  await dialog.getByLabel('Event name').fill('Weekly team practice');
  await dialog.getByRole('button', { name: 'Save event' }).click();
  await expect(dialog).not.toBeVisible();
  const saved = (await household(request)).events.find((e: { id: string }) => e.id === original.id);
  expect(saved).toMatchObject({
    id: original.id,
    date: original.date,
    externalId: 'local-legacy-id',
    timeZone: 'Europe/London',
    recurrence: { frequency: 'weekly', until },
    notes: original.notes,
  });
});

test('cancel discards edits; all-day date changes save from the month view', async ({
  page,
  request,
}) => {
  const original = (await household(request)).events.find((e: { id: string }) => e.id === 'dinner');
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'month', exact: true }).click();
  await page.getByRole('button', { name: /Dinner · Tacos/ }).click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Event name').fill('Do not save this');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await household(request)).events.find((e: { id: string }) => e.id === 'dinner')).toEqual(
    original,
  );
  await page.getByRole('button', { name: /Dinner · Tacos/ }).click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('All-day event').check();
  await dialog.getByLabel('Date', { exact: true }).fill('2026-10-15');
  await dialog.getByRole('button', { name: 'Save event' }).click();
  await expect(dialog).not.toBeVisible();
  const saved = (await household(request)).events.find((e: { id: string }) => e.id === 'dinner');
  expect(saved).toMatchObject({ date: '2026-10-15', allDay: true });
  expect(saved.startTime).toBeUndefined();
  expect(saved.endTime).toBeUndefined();
});

test('a lost edit response keeps the draft and retries without duplicating the event', async ({
  page,
  request,
}) => {
  await page.goto('/#calendar');
  await page.getByRole('button', { name: /Soccer practice/ }).click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Event name').fill('Recovered edit');
  await page.route(
    '**/api/mutations',
    async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Response interrupted', code: 'unavailable' }),
      });
    },
    { times: 1 },
  );
  await dialog.getByRole('button', { name: 'Save event' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your entries are still here');
  await expect(dialog.getByLabel('Event name')).toHaveValue('Recovered edit');
  await dialog.getByRole('button', { name: 'Save event' }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /Recovered edit/ })).toHaveCount(1);
  expect(
    (await household(request)).events.filter((e: { id: string }) => e.id === 'soccer'),
  ).toHaveLength(1);
});

test('an event changed on another device while the editor is open is not overwritten', async ({
  page,
  request,
}) => {
  await page.goto('/#calendar');
  await page.getByRole('button', { name: /Soccer practice/ }).click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Event name').fill('My draft');
  const original = (await household(request)).events.find((e: { id: string }) => e.id === 'soccer');
  await update(request, { ...original, title: 'Changed on another device' });
  const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/household'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(page.getByText('Household up to date', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save event' }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed while you were editing');
  await expect(dialog.getByLabel('Event name')).toHaveValue('My draft');
  expect(
    (await household(request)).events.find((e: { id: string }) => e.id === 'soccer').title,
  ).toBe('Changed on another device');
});
