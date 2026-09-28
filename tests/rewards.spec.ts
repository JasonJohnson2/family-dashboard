import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { HouseholdState, Operation } from '../src/data/contracts';
import { starBalance, type Reward } from '../src/data/rewards';

test.use({ serviceWorkers: 'block' });
test.setTimeout(60_000);
const pin = 'test-only-48269173';
async function prepare(request: APIRequestContext) {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  const login = await request.post('/api/rewards/operator', { data: { pin } });
  const { token } = await login.json();
  let latest = (await (await request.get('/api/household')).json()) as HouseholdState;
  async function save(op: Operation) {
    const response = await request.post('/api/mutations', {
      headers: { 'X-Reward-Operator': token },
      data: { id: crypto.randomUUID(), revision: latest.household.revision, operations: [op] },
    });
    expect(response.ok(), await response.text()).toBe(true);
    latest = (await response.json()) as HouseholdState;
  }
  const state = latest;
  const member = state.family[0];
  const definitions: Pick<Reward, 'name' | 'icon' | 'starCost'>[] = [
    { name: 'Pick dinner', icon: '🍕', starCost: 30 },
    { name: 'Extra game time', icon: '🎮', starCost: 50 },
    { name: 'Choose movie night', icon: '🎬', starCost: 25 },
    { name: 'Pick dessert', icon: '🍦', starCost: 20 },
    { name: 'Creative afternoon', icon: '🎨', starCost: 15 },
    { name: 'Garden sleepover', icon: '⛺', starCost: 75 },
  ];
  for (const [index, r] of definitions.entries())
    await save({
      type: 'reward.put',
      value: {
        ...r,
        id: `reward_${index}`,
        description: '',
        active: true,
        reusable: true,
        requiresApproval: index === 2,
        memberIds: [],
      },
    });
  for (const [index, m] of state.family.entries())
    await save({
      type: 'stars.adjust',
      memberId: m.id,
      amount: [42, 28, 15, 10][index] ?? 5,
      note: 'A helpful start',
    });
  return { member, state, save };
}
async function unlock(page: Page) {
  await page.getByRole('button', { name: 'Unlock operator controls' }).click();
  await page.getByLabel('Operator PIN', { exact: true }).fill(pin);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lock operator controls' })).toBeVisible();
}

test('redeem, approve and retain balances after reload; keep controls locked without PIN', async ({
  page,
  request,
}) => {
  await prepare(request);
  await page.goto('/#rewards');
  await expect(
    page.getByRole('heading', { name: 'Do tasks, earn stars, get rewarded!' }),
  ).toBeVisible();
  const movie = page
    .locator('.reward-card')
    .filter({ has: page.getByRole('heading', { name: 'Choose movie night', exact: true }) });
  await movie.getByRole('button', { name: 'Request', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm request' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(movie.getByRole('button', { name: 'Requested' })).toBeDisabled();
  await page.getByRole('button', { name: /Manage rewards/ }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await unlock(page);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByText('All caught up. No requests waiting.')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.locator('.member-reward.selected strong')).toHaveText('17stars');
  await page.reload();
  await expect(page.locator('.member-reward.selected strong')).toHaveText('17stars');
  await page.getByRole('button', { name: /Manage rewards/ }).click();
  await expect(page.getByRole('button', { name: 'Unlock operator controls' })).toBeVisible();
});

test('create/edit a reward, adjust stars with confirmation, and earn/undo a paid chore', async ({
  page,
  request,
}) => {
  const { member, state } = await prepare(request);
  await page.goto('/#rewards');
  await page.getByRole('button', { name: /Manage rewards/ }).click();
  await unlock(page);
  await page.getByRole('button', { name: 'Create reward' }).click();
  await page.getByLabel('Reward name', { exact: true }).fill('Choose a book');
  await page.getByLabel('Star cost').fill('12');
  await page.getByRole('button', { name: 'Save reward' }).click();
  await page.getByRole('button', { name: 'Edit Choose a book', exact: true }).click();
  await page.getByLabel('Reward name', { exact: true }).fill('Library afternoon');
  await page.getByRole('button', { name: 'Save reward' }).click();
  await page.getByLabel('Adjustment (positive or negative)').fill('8');
  await page.getByLabel('Reason', { exact: true }).fill('Helped with the garden');
  await page.getByRole('button', { name: 'Review adjustment' }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByText('Current balance: 50 stars')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Chores', exact: true }).click();
  const chore = state.chores.find((c) => c.memberIds.includes(member.id))!;
  await page.getByRole('button', { name: `Edit ${chore.title}`, exact: true }).click();
  await page.getByLabel('Reward stars').fill('5');
  await page.getByRole('button', { name: 'Save chore' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const box = page.getByRole('checkbox', { name: new RegExp(chore.title) });
  const completion = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/mutations') &&
      response.request().method() === 'POST' &&
      response
        .request()
        .postDataJSON()
        .operations.some((op: Operation) => op.type === 'chore.complete' && op.completed === true),
  );
  await box.check();
  const completed = await completion;
  expect(completed.ok()).toBe(true);
  expect(
    starBalance(((await completed.json()) as HouseholdState).starTransactions, member.id),
  ).toBe(55);
  await page.getByRole('navigation').getByRole('link', { name: 'Rewards', exact: true }).click();
  await expect(page.locator('.member-reward.selected strong')).toHaveText('55stars');
  await page.getByRole('navigation').getByRole('link', { name: 'Chores', exact: true }).click();
  await box.click();
  const reversal = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/mutations') &&
      response.request().method() === 'POST' &&
      response
        .request()
        .postDataJSON()
        .operations.some((op: Operation) => op.type === 'chore.complete' && op.completed === false),
  );
  await page.getByRole('button', { name: 'Undo completion', exact: true }).click();
  await expect(box).not.toBeChecked();
  const reversed = await reversal;
  expect(reversed.ok()).toBe(true);
  expect(starBalance(((await reversed.json()) as HouseholdState).starTransactions, member.id)).toBe(
    50,
  );
  await page.getByRole('navigation').getByRole('link', { name: 'Rewards', exact: true }).click();
  await expect(page.locator('.member-reward.selected strong')).toHaveText('50stars');
});

test('a lost redemption response reconciles without a second spend', async ({ page, request }) => {
  await prepare(request);
  await page.goto('/#rewards');
  let lost = false;
  await page.route('**/api/mutations', async (route) => {
    if (!lost) {
      lost = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  const dinner = page
    .locator('.reward-card')
    .filter({ has: page.getByRole('heading', { name: 'Pick dinner', exact: true }) });
  await dinner.getByRole('button', { name: 'Redeem', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm redemption' }).click();
  await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByText('Household up to date', { exact: true })).toBeVisible();
  await expect(page.locator('.member-reward.selected strong')).toHaveText('12stars');
  expect((await (await request.get('/api/household')).json()).redemptions).toHaveLength(1);
});

test('Rewards visual review across desktop, landscape, portrait and phone', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'tablet-chromium',
    'Viewport matrix runs once; phone flows also run in WebKit.',
  );
  await prepare(request);
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['landscape', 1180, 820],
    ['portrait', 820, 1180],
    ['phone', 390, 844],
    ['narrow', 320, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/#rewards');
    await expect(page.locator('.reward-card')).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`rewards-${name}.png`), fullPage: true });
    if (width === 390) {
      await page.getByRole('button', { name: 'More navigation' }).click();
      await page.getByRole('link', { name: 'Lists', exact: true }).click();
      await expect(page).toHaveTitle('Lists · Our Home');
      await page.getByRole('link', { name: 'Rewards', exact: true }).click();
      await expect(page).toHaveTitle('Rewards · Our Home');
      await page.getByRole('button', { name: /Manage rewards/ }).click();
      await unlock(page);
      await page.getByRole('button', { name: 'Create reward' }).click();
      await page.screenshot({
        path: testInfo.outputPath('reward-editor-phone.png'),
        fullPage: true,
      });
      expect(
        await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
  }
});
