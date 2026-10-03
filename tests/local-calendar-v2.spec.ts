import { test, expect, type APIRequestContext } from './fixtures';
import { loginHousehold } from './access-fixture';
import { civilDay, weekday } from '../src/lib/calendarDates';
import { weekStart } from '../src/lib/dates';
import type { HouseholdState, Operation } from '../src/data/contracts';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  await loginHousehold(request);
});
const state = async (request: APIRequestContext) =>
  (await (await request.get('/api/household')).json()) as HouseholdState;
async function save(request: APIRequestContext, operations: Operation[]) {
  const before = await state(request);
  const r = await request.post('/api/mutations', {
    data: { id: crypto.randomUUID(), revision: before.household.revision, operations },
  });
  expect(r.ok(), await r.text()).toBe(true);
}
const occurrences = async (request: APIRequestContext, from: string, to = from) =>
  await (await request.get('/api/calendar/events?from=' + from + '&to=' + to)).json();

test('soccer: create two weekdays, move one, edit future, delete one, delete future; reload and filter reflect persistence', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const before = await state(request);
  const sam = before.family[1],
    millie = before.family[2];
  await save(request, [
    { type: 'member.put', value: { ...sam, name: 'Sam', initial: 'S' } },
    { type: 'member.put', value: { ...millie, name: 'Millie', initial: 'M' } },
  ]);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: before.household.timeZone }),
    tuesday = civilDay(today, (2 - weekday(today) + 7) % 7),
    wednesday = civilDay(tuesday, 1),
    thursday = civilDay(tuesday, 2),
    nextTuesday = civilDay(tuesday, 7),
    nextThursday = civilDay(tuesday, 9);
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Event name').fill('Soccer Practice V2');
  await dialog.getByLabel('Date', { exact: true }).fill(tuesday);
  await dialog.getByLabel('Starts', { exact: true }).fill('17:30');
  await dialog.getByLabel('Ends', { exact: true }).fill('19:00');
  await dialog.getByRole('button', { name: /Sam/ }).click();
  await dialog.getByRole('button', { name: /Millie/ }).click();
  await dialog.getByLabel('Repeat', { exact: true }).selectOption('custom');
  await dialog.getByLabel('Thursday', { exact: true }).check();
  await dialog.getByText('Location, notes & reminder', { exact: true }).click();
  await dialog.getByLabel('Location', { exact: true }).fill('Soccer Fields');
  await dialog.getByLabel('Notes', { exact: true }).fill('Bring cleats and water');
  await dialog.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  let current = await state(request);
  const master = current.events.find((e) => e.title === 'Soccer Practice V2')!;
  expect(master.memberIds).toEqual([sam.id, millie.id]);
  expect(
    (await occurrences(request, tuesday, thursday)).filter(
      (e: { id: string }) => e.id === master.id,
    ),
  ).toHaveLength(2);
  if (weekStart(tuesday) !== weekStart(today))
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await page
    .getByRole('button', { name: '5:30 PM Soccer Practice V2', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await page.getByLabel('This event', { exact: true }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Date', { exact: true }).fill(wednesday);
  await dialog.getByLabel('Starts', { exact: true }).fill('18:00');
  await dialog.getByLabel('Ends', { exact: true }).fill('19:30');
  await dialog.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await occurrences(request, tuesday)).filter((e: { id: string }) => e.id === master.id),
  ).toHaveLength(0);
  expect(
    (await occurrences(request, wednesday)).find((e: { id: string }) => e.id === master.id),
  ).toMatchObject({ startTime: '18:00', recurrenceDate: tuesday });
  await page.reload();
  if (weekStart(tuesday) !== weekStart(today))
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '6:00 PM Soccer Practice V2', exact: true }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: '5:30 PM Soccer Practice V2', exact: true }).click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await page.getByLabel('This and future events', { exact: true }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Starts', { exact: true }).fill('18:00');
  await dialog.getByLabel('Ends', { exact: true }).fill('19:30');
  await dialog.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  current = await state(request);
  const future = current.events.find(
    (e) => e.title === 'Soccer Practice V2' && e.id !== master.id,
  )!;
  expect(future.date).toBe(thursday);
  expect(current.eventExceptions.find((e) => e.eventId === master.id)?.recurrenceDate).toBe(
    tuesday,
  );
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await page
    .getByRole('button', { name: '6:00 PM Soccer Practice V2', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Delete event', exact: true }).click();
  await page.getByLabel('This event', { exact: true }).check();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(
    (await occurrences(request, nextTuesday)).filter((e: { id: string }) => e.id === future.id),
  ).toHaveLength(0);
  expect(
    (await occurrences(request, nextThursday)).filter((e: { id: string }) => e.id === future.id),
  ).toHaveLength(1);
  await page.getByRole('button', { name: '6:00 PM Soccer Practice V2', exact: true }).click();
  await page.getByRole('button', { name: 'Delete event', exact: true }).click();
  await page.getByLabel('This and future events', { exact: true }).check();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(
    (await occurrences(request, nextThursday)).filter((e: { id: string }) => e.id === future.id),
  ).toHaveLength(0);
  expect(
    (await occurrences(request, wednesday)).find((e: { id: string }) => e.id === master.id),
  ).toBeTruthy();
  expect(
    (await occurrences(request, thursday)).find((e: { id: string }) => e.id === future.id),
  ).toBeTruthy();
});

test('member filters include occurrence assignments; all-day multi-day events appear in Home/day/month and notes remain plain text', async ({
  page,
  request,
}) => {
  const before = await state(request),
    today = new Date().toLocaleDateString('en-CA', { timeZone: before.household.timeZone }),
    id = 'v2-vacation';
  await save(request, [
    {
      type: 'event.put',
      value: {
        id,
        sourceId: 'local',
        title: 'Vacation V2',
        date: today,
        endDate: civilDay(today, 2),
        allDay: true,
        timeZone: before.household.timeZone,
        memberIds: [],
        recurrence: { frequency: 'none' },
        location: 'Grandma’s house',
        notes: '<script>alert(1)</script>\nBring a book',
      },
    },
    {
      type: 'event.put',
      value: {
        id: 'v2-repeat',
        sourceId: 'local',
        title: 'Practice V2',
        date: today,
        startTime: '17:30',
        endTime: '19:00',
        allDay: false,
        timeZone: before.household.timeZone,
        memberIds: [before.family[0].id],
        recurrence: { frequency: 'daily' },
      },
    },
    {
      type: 'event.edit',
      id: 'v2-repeat',
      recurrenceDate: today,
      scope: 'this',
      value: {
        id: 'v2-repeat',
        sourceId: 'local',
        title: 'Practice V2',
        date: today,
        startTime: '17:30',
        endTime: '19:00',
        allDay: false,
        timeZone: before.household.timeZone,
        memberIds: [before.family[2].id],
        recurrence: { frequency: 'none' },
      },
    },
  ]);
  await page.goto('/#home');
  await expect(page.getByRole('button', { name: /Vacation V2/ }).first()).toBeVisible();
  await page
    .getByRole('button', { name: /Vacation V2/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toContainText('<script>alert(1)</script>');
  await page.getByRole('button', { name: 'Lovely, got it' }).click();
  await page.getByRole('link', { name: 'Calendar', exact: true }).first().click();
  await page.getByRole('button', { name: before.family[2].name, exact: true }).click();
  await expect(page.getByRole('button', { name: /Practice V2/ }).first()).toBeVisible();
  await page.getByRole('button', { name: before.family[0].name, exact: true }).click();
  await page.getByRole('button', { name: 'day', exact: true }).click();
  await expect(page.getByRole('button', { name: /Practice V2/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Vacation V2/ })).toBeVisible();
  await page.getByRole('button', { name: 'month', exact: true }).click();
  await expect(page.getByRole('button', { name: /Vacation V2/ })).toHaveCount(3);
});

test('responsive editor review at desktop, wall tablet, portrait iPad and 390px phone', async ({
  page,
}, testInfo) => {
  for (const [name, width, height] of [
    ['desktop', 1600, 1000],
    ['wall-tablet', 1180, 820],
    ['ipad-portrait', 820, 1180],
    ['phone', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/#calendar');
    await page.getByRole('button', { name: 'Add event', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Event name').fill('Soccer Practice');
    await dialog.getByLabel('Repeat', { exact: true }).selectOption('custom');
    await dialog.getByLabel('Thursday', { exact: true }).check();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Add event', exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'Add event', exact: true })).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath('event-editor-' + name + '.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});

test.describe('Household timezone clock', () => {
  test.use({ timezoneId: 'UTC' });
  test('Today and new event dates roll over at household midnight on another browser timezone', async ({
    page,
    request,
  }) => {
    const before = await state(request);
    await save(request, [
      {
        type: 'settings.put',
        value: { name: before.household.name, timeZone: 'America/New_York' },
      },
    ]);
    await page.clock.install({ time: new Date('2026-10-03T03:59:45Z') });
    await page.goto('/#calendar');
    await page.getByRole('button', { name: 'Add event', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('Date', { exact: true })).toHaveValue(
      '2026-10-02',
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.clock.runFor(30_000);
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.getByRole('button', { name: 'Add event', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('Date', { exact: true })).toHaveValue(
      '2026-10-03',
    );
  });
});
