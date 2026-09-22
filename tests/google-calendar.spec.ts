import { test, expect } from '@playwright/test';
import type { HouseholdState } from '../src/data/contracts';

test.use({ serviceWorkers: 'block' });

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
