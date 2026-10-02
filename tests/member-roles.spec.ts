import { test, expect, type APIRequestContext } from './fixtures';
import { loginHousehold } from './access-fixture';
import type { HouseholdState, Operation } from '../src/data/contracts';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);
async function setup(request: APIRequestContext) {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
  await loginHousehold(request);
  const { token } = await (
    await request.post('/api/rewards/operator', { data: { pin: 'test-only-48269173' } })
  ).json();
  async function state(): Promise<HouseholdState> {
    return (await request.get('/api/household')).json();
  }
  async function save(op: Operation) {
    const response = await request.post('/api/mutations', {
      headers: { 'X-Reward-Operator': token },
      data: {
        id: crypto.randomUUID(),
        revision: (await state()).household.revision,
        operations: [op],
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  return { state, save };
}

test('family editor creates adult and child roles; Home and Rewards handle zero children', async ({
  page,
  request,
}, info) => {
  const { state } = await setup(request);
  await page.goto('/#rewards');
  await expect(
    page.getByRole('heading', { name: 'No kids are set up for Rewards yet.' }),
  ).toBeVisible();
  await expect(page.locator('.member-reward')).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage family', exact: true }).click();
  await expect(page.getByLabel('Member 1 type')).toHaveValue('adult');
  await page.getByRole('button', { name: 'Add family member' }).click();
  await page.getByLabel('Member 5 name').fill('Grownup');
  await page.getByRole('button', { name: 'Add family member' }).click();
  await page.getByLabel('Member 6 name').fill('Youngster');
  await page.getByLabel('Member 6 type').selectOption('child');
  await page.getByRole('dialog').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: info.outputPath('family-roles.png'), fullPage: true });
  await page.getByLabel('Member 6 name').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('family-new-members.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save family', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.member-reward')).toHaveCount(1);
  await expect(page.locator('.member-reward')).toContainText('Youngster');
  expect((await state()).family.find((m) => m.name === 'Grownup')?.role).toBe('adult');
  await page.goto('/#home');
  await expect(page.locator('.home-star-balances')).toContainText('Youngster');
  await expect(page.locator('.home-star-balances')).not.toContainText('Grownup');
  await page.getByRole('button', { name: 'Manage family members' }).click();
  await page.getByLabel('Member 6 type').selectOption('adult');
  await page.getByRole('button', { name: 'Save family', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.home-rewards')).toContainText('No kids are set up for Rewards yet.');
  await page.locator('.home-rewards').getByRole('button', { name: 'Manage family' }).click();
  await page.getByLabel('Member 6 type').selectOption('child');
  await page.getByRole('button', { name: 'Save family', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.home-star-balances')).toContainText('Youngster');
});

test('mixed household shows child participants and targets, retains adult history and prevents approval', async ({
  page,
  request,
}, info) => {
  const { state, save } = await setup(request);
  const family = (await state()).family;
  const child = { ...family[0], role: 'child' as const };
  const former = { ...family[1], role: 'child' as const };
  for (const member of [child, former]) {
    await save({ type: 'member.put', value: member });
    await save({
      type: 'stars.adjust',
      memberId: member.id,
      amount: 40,
      note: 'Historical effort',
    });
  }
  await save({
    type: 'reward.put',
    value: {
      id: 'treat',
      name: 'Choose dessert',
      description: '',
      icon: '🍦',
      starCost: 10,
      active: true,
      reusable: true,
      requiresApproval: true,
      memberIds: [],
    },
  });
  await save({ type: 'reward.redeem', id: 'old-request', rewardId: 'treat', memberId: former.id });
  await save({ type: 'member.put', value: { ...former, role: 'adult' } });
  await page.goto('/#rewards');
  await expect(page.locator('.member-reward')).toHaveCount(1);
  await expect(page.locator('.member-reward')).toContainText(child.name);
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['tablet', 1180, 820],
    ['phone', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`rewards-children-${name}.png`),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request this reward?' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('child-reward-request.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Household reward history', exact: true }).click();
  await expect(page.locator('.reward-activity')).toContainText(former.name);
  await expect(page.locator('.reward-activity')).toContainText('Historical effort');
  await page.getByRole('button', { name: /Manage rewards/ }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Unlock operator controls' }).click();
  await page.getByLabel('Operator PIN', { exact: true }).fill('test-only-48269173');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await expect(page.locator('.star-adjustment option')).toHaveCount(1);
  await expect(page.locator('.star-adjustment option')).toHaveText(child.name);
  await page.screenshot({ path: info.outputPath('approval-former-child.png'), fullPage: true });
  await page.getByRole('button', { name: 'Edit Choose dessert' }).click();
  const recipients = page.getByRole('group', { name: 'Available to', exact: true });
  await expect(recipients.getByRole('button', { name: 'All kids' })).toBeVisible();
  await expect(recipients.getByRole('button')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('reward-child-eligibility.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save reward', exact: true }).click();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm change', exact: true }).click();
  await expect(page.getByText('All caught up. No requests waiting.')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.goto('/#home');
  await expect(page.locator('.home-star-balances')).not.toContainText(former.name);
  await page.screenshot({ path: info.outputPath('home-children.png'), fullPage: true });
});

test('adults complete a shared paid chore without stars and children earn its award', async ({
  page,
  request,
}, info) => {
  const { state, save } = await setup(request);
  const data = await state();
  const child = data.family[0],
    adult = data.family[1];
  await save({ type: 'member.put', value: { ...child, role: 'child' } });
  const day = data.chores[0].dueDate;
  await save({
    type: 'chore.put',
    value: {
      id: 'shared-paid',
      title: 'Shared star chore',
      memberIds: [child.id, adult.id],
      stars: 5,
      dueDate: day,
      recurrence: { frequency: 'daily' },
      completedDates: [],
    },
  });
  await page.goto('/#chores');
  const box = page.getByRole('checkbox', { name: /Shared star chore/ });
  await box.click();
  await page.getByLabel('Completed by').selectOption(adult.id);
  await expect(page.getByRole('button', { name: 'Complete chore', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('adult-chore-completion.png'), fullPage: true });
  await page.getByRole('button', { name: 'Complete chore', exact: true }).click();
  await expect(box).toBeChecked();
  await expect(page.getByText('Household up to date', { exact: true })).toBeVisible();
  expect((await state()).starTransactions).toEqual([]);
  await box.click();
  await page.getByRole('button', { name: 'Undo completion' }).click();
  await expect(box).not.toBeChecked();
  await box.click();
  await page.getByLabel('Completed by').selectOption(child.id);
  await page.getByRole('button', { name: 'Complete and earn stars' }).click();
  await expect(page.getByText('Household up to date', { exact: true })).toBeVisible();
  expect((await state()).starTransactions).toMatchObject([{ memberId: child.id, amount: 5 }]);
  await page.getByRole('button', { name: 'Edit Shared star chore' }).click();
  await page.screenshot({ path: info.outputPath('shared-chore-edit.png'), fullPage: true });
  // Chore assignments still contain adults and children.
  await expect(page.locator('.assign-members')).toContainText(adult.name);
  await expect(page.locator('.assign-members')).toContainText(child.name);
});
