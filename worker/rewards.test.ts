import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigration, createDatabase, migrate, seed } from '../scripts/test-database';
import type { HouseholdState, Mutation, Operation } from '../src/data/contracts';
import {
  childMembers,
  eligibleFor,
  rewardSchema,
  starBalance,
  type Reward,
} from '../src/data/rewards';
import { readState } from './database';
import { authenticatedWorker as worker, testSession } from '../scripts/test-auth';

describe('Rewards on real D1', () => {
  let runtime: ReturnType<typeof createDatabase>, db: D1Database, env: Env, token: string;
  const pin = 'test-only-48269173';
  const member = {
    id: 'alex',
    name: 'Alex',
    role: 'child' as const,
    initial: 'A',
    color: '#123456',
    tint: '#eeeeee',
  };
  const reward: Reward = {
    id: 'dinner',
    name: 'Pick dinner',
    description: 'Your choice tonight',
    icon: '🍕',
    starCost: 10,
    active: true,
    reusable: true,
    requiresApproval: false,
    memberIds: [],
  };
  const chore = {
    id: 'dishes',
    title: 'Dishes',
    dueDate: '2026-09-19',
    recurrence: { frequency: 'daily' as const },
    memberIds: ['alex'],
    completedDates: [],
    stars: 5,
  };
  const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request(`https://home.test${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );
  const load = () => readState(db);
  const balance = (state: HouseholdState) => starBalance(state.starTransactions, 'alex');
  const send = (body: Mutation, authorized = true) =>
    call('/api/mutations', body, authorized ? { 'X-Reward-Operator': token } : {});
  async function save(op: Operation, expected = 200, authorized = true) {
    const state = await load();
    const response = await send(
      { id: crypto.randomUUID(), revision: state.household.revision, operations: [op] },
      authorized,
    );
    expect(response.status, await response.clone().text()).toBe(expected);
    return response.ok ? ((await response.json()) as HouseholdState) : load();
  }
  const adjust = (amount: number) =>
    save({ type: 'stars.adjust', memberId: 'alex', amount, note: 'Helped in the garden' });
  const redeem = (id = crypto.randomUUID()) =>
    save({ type: 'reward.redeem', id, rewardId: 'dinner', memberId: 'alex' });
  const complete = (date = '2026-09-19', completed = true) =>
    save({ type: 'chore.complete', id: 'dishes', date, completed, memberId: 'alex' });
  beforeEach(async () => {
    runtime = createDatabase();
    db = (await runtime.getD1Database('DB')) as unknown as D1Database;
    await migrate(db);
    await testSession(db);
    env = {
      GOOGLE_APP_ORIGIN: 'https://home.test',
      AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
      DB: db,
      ASSETS: { fetch: async () => new Response('shell') } as Fetcher,
      REWARDS_OPERATOR_PIN: pin,
    };
    const response = await call('/api/rewards/operator', { pin });
    expect(response.status).toBe(200);
    token = ((await response.json()) as { token: string }).token;
    await save({ type: 'member.put', value: member });
  });
  afterEach(async () => {
    await runtime.dispose();
  });

  it('creates explicit roles, preserves normal adult chores, and never awards an adult stars', async () => {
    const adult = { ...member, id: 'parent', name: 'Parent', role: 'adult' as const };
    await save({ type: 'member.put', value: adult }, 200, false);
    await save({ type: 'chore.put', value: { ...chore, memberIds: ['alex', 'parent'] } });
    const response = await save(
      {
        type: 'chore.complete',
        id: chore.id,
        date: chore.dueDate,
        completed: true,
        memberId: adult.id,
      },
      200,
      false,
    );
    expect(response.chores[0].completedDates).toContain(chore.dueDate);
    expect(response.choreAwards).toEqual([]);
    expect(response.starTransactions).toEqual([]);
    await save(
      { type: 'chore.complete', id: chore.id, date: chore.dueDate, completed: false },
      200,
      false,
    );
    expect(balance(await complete())).toBe(5);
    expect(balance(await complete())).toBe(5);
    await save({ type: 'stars.adjust', memberId: adult.id, amount: 5, note: 'Direct bypass' }, 422);
    const malformed = await send({
      id: crypto.randomUUID(),
      revision: (await load()).household.revision,
      operations: [{ type: 'member.put', value: { ...adult, role: 'operator' } }],
    } as unknown as Mutation);
    expect(malformed.status).toBe(400);
  });

  it('requires actual household child eligibility for redemption, requests, adjustments and approvals', async () => {
    await adjust(40);
    await save({ type: 'reward.put', value: reward });
    await redeem('enjoyed');
    await save({ type: 'reward.put', value: { ...reward, requiresApproval: true } });
    await redeem('pending');
    const before = await load();
    const adult = { ...member, role: 'adult' as const };
    await save({ type: 'member.put', value: adult }, 200, false);
    expect(childMembers((await load()).family)).toEqual([]);
    expect(eligibleFor(reward, adult)).toBe(false);
    for (const requiresApproval of [false, true]) {
      await save({ type: 'reward.put', value: { ...reward, requiresApproval } });
      await save(
        { type: 'reward.redeem', id: crypto.randomUUID(), rewardId: reward.id, memberId: adult.id },
        422,
      );
    }
    await save(
      { type: 'stars.adjust', memberId: adult.id, amount: -5, note: 'No adult spend' },
      422,
    );
    await save({ type: 'reward.resolve', id: 'pending', approve: true }, 422);
    const after = await load();
    expect(after.starTransactions).toEqual(before.starTransactions);
    expect(after.redemptions).toEqual(before.redemptions);
    await save({ type: 'member.put', value: member }, 200, false);
    expect(balance(await load())).toBe(30);
    expect(childMembers((await load()).family)).toEqual([member]);
    await save({ type: 'reward.resolve', id: 'pending', approve: true });
    expect(balance(await load())).toBe(20);
    // Roles never grant operator authorization.
    await save(
      { type: 'stars.adjust', memberId: member.id, amount: 1, note: 'PIN still required' },
      403,
      false,
    );
  }, 60_000);

  it('retains restricted recipients without broadening eligibility and can decline former-child requests', async () => {
    await save({ type: 'member.put', value: { ...member, id: 'other-child' } });
    await adjust(20);
    await save({
      type: 'reward.put',
      value: { ...reward, memberIds: ['alex'], requiresApproval: true },
    });
    await redeem('pending');
    await save({ type: 'member.put', value: { ...member, role: 'adult' } });
    const restricted = (await load()).rewards[0];
    expect(restricted.memberIds).toEqual(['alex']);
    expect(
      eligibleFor(
        restricted,
        (await load()).family.find((m) => m.id === 'other-child'),
      ),
    ).toBe(false);
    await save({
      type: 'reward.put',
      value: { ...rewardSchema.strip().parse(restricted), active: false },
    });
    await save({ type: 'reward.put', value: { ...reward, id: 'new', memberIds: ['alex'] } }, 422);
    await save({ type: 'reward.resolve', id: 'pending', approve: false });
    expect(balance(await load())).toBe(20);
    expect((await load()).redemptions[0].status).toBe('declined');
    await save({ type: 'reward.put', value: reward });
    expect(
      eligibleFor(
        reward,
        (await load()).family.find((m) => m.id === 'other-child'),
      ),
    ).toBe(true);
    expect(
      eligibleFor(
        reward,
        (await load()).family.find((m) => m.id === 'alex'),
      ),
    ).toBe(false);
  });

  it('reverses a historical child award after becoming adult without creating a new adult award', async () => {
    await save({ type: 'chore.put', value: chore });
    await complete();
    const earned = await load();
    await save({ type: 'member.put', value: { ...member, role: 'adult' } });
    expect((await load()).starTransactions).toEqual(earned.starTransactions);
    await complete(chore.dueDate, false);
    expect(balance(await load())).toBe(0);
    await complete();
    expect((await load()).starTransactions).toHaveLength(2);
    expect((await load()).choreAwards).toHaveLength(1);
    await save({ type: 'member.put', value: member });
    // A previously completed adult chore must not gain a retroactive award.
    await complete();
    expect(balance(await load())).toBe(0);
    await complete(chore.dueDate, false);
    expect(balance(await complete())).toBe(5);
  });

  it('prevents role/financial batch bypasses and rejects a child from another household', async () => {
    await save({ type: 'member.put', value: { ...member, role: 'adult' } });
    const before = await load();
    const response = await send({
      id: crypto.randomUUID(),
      revision: before.household.revision,
      operations: [
        { type: 'member.put', value: member },
        { type: 'stars.adjust', memberId: member.id, amount: 10, note: 'Batch' },
      ],
    });
    expect(response.status).toBe(400);
    expect(await load()).toEqual(before);
    await db.batch([
      db.prepare("INSERT INTO households (id,name,timeZone) VALUES ('elsewhere','Other','UTC')"),
      db.prepare(
        "INSERT INTO members (household_id,id,name,initial,color,tint,role) VALUES ('elsewhere','foreign-child','Child','C','#123456','#eeeeee','child')",
      ),
    ]);
    await save({ type: 'reward.put', value: reward });
    await save(
      { type: 'reward.redeem', id: 'bad', rewardId: reward.id, memberId: 'foreign-child' },
      400,
    );
    await save({ type: 'stars.adjust', memberId: 'foreign-child', amount: 5, note: 'No' }, 400);
    await save({ type: 'reward.put', value: { ...reward, memberIds: ['foreign-child'] } }, 400);
  });

  it('defaults existing members to adults without rewriting historical data or initializing balances', async () => {
    const oldRuntime = createDatabase();
    try {
      const old = (await oldRuntime.getD1Database('DB')) as unknown as D1Database;
      await migrate(old, '0006_household_access.sql');
      await seed(old);
      await old
        .prepare(
          "INSERT INTO star_transactions(household_id,id,memberId,amount,type,note,createdAt) VALUES ('home','historical','jason',120,'manual_adjustment','Existing history','2026-01-01')",
        )
        .run();
      const names = [
        'households',
        'members',
        'events',
        'event_members',
        'chore_completions',
        'meals',
        'lists',
        'list_items',
        'rewards',
        'reward_members',
        'reward_redemptions',
        'star_transactions',
        'google_connections',
        'google_calendars',
        'household_credentials',
        'household_sessions',
      ];
      const before = await Promise.all(
        names.map(async (t) => (await old.prepare(`SELECT * FROM ${t}`).all()).results),
      );
      await applyMigration(old, '0007_member_roles.sql');
      for (const [i, table] of names.entries()) {
        const rows = (await old.prepare(`SELECT * FROM ${table}`).all()).results;
        expect(table === 'members' ? rows.map(({ role: _, ...rest }) => rest) : rows).toEqual(
          before[i],
        );
      }
      const state = await readState(old);
      expect(state.family.every((m) => m.role === 'adult')).toBe(true);
      expect(childMembers(state.family)).toEqual([]);
      expect(starBalance(state.starTransactions, 'jason')).toBe(120);
      await expect(old.prepare("UPDATE members SET role='unknown'").run()).rejects.toThrow();
    } finally {
      await oldRuntime.dispose();
    }
  });

  it('requires a PIN server-side for management, adjustments, approvals and paid chore configuration', async () => {
    await save({ type: 'reward.put', value: reward }, 403, false);
    await save({ type: 'stars.adjust', memberId: 'alex', amount: 50, note: 'Bonus' }, 403, false);
    await save({ type: 'chore.put', value: chore }, 403, false);
    await save({ type: 'reward.put', value: reward });
    await adjust(20);
    await save({ type: 'reward.delete', id: 'dinner' }, 403, false);
    await save({ type: 'reward.put', value: { ...reward, requiresApproval: true } });
    await redeem('request');
    await save({ type: 'reward.resolve', id: 'request', approve: true }, 403, false);
    await save({ type: 'chore.put', value: chore });
    await save({ type: 'chore.put', value: { ...chore, stars: 0 } }, 403, false);
    expect(balance(await load())).toBe(20);
  });
  it('limits PIN guessing, expires sessions, revokes on PIN rotation and never exposes secrets', async () => {
    expect((await call('/api/rewards/operator', null)).status).toBe(400);
    expect((await call('/api/rewards/operator', { pin, householdId: 'other' })).status).toBe(400);
    for (let i = 0; i < 4; i++)
      expect((await call('/api/rewards/operator', { pin: 'bad' })).status).toBe(403);
    expect((await call('/api/rewards/operator', { pin })).status).toBe(429);
    const attempts = await db
      .prepare('SELECT attempts FROM reward_pin_attempts')
      .first<{ attempts: number }>();
    expect(attempts?.attempts).toBe(5);
    expect((await call('/api/rewards/operator', { pin })).status).toBe(429);
    expect(
      (await db.prepare('SELECT attempts FROM reward_pin_attempts').first<{ attempts: number }>())
        ?.attempts,
    ).toBe(5);
    await db.prepare('UPDATE reward_operator_sessions SET expiresAt=0').run();
    await save({ type: 'reward.put', value: reward }, 403);
    await db
      .prepare('UPDATE reward_operator_sessions SET expiresAt=?')
      .bind(Date.now() + 10000)
      .run();
    env.REWARDS_OPERATOR_PIN = 'different-pin';
    await save({ type: 'reward.put', value: reward }, 403);
    const response = await worker.fetch(new Request('https://home.test/api/household'), env);
    const text = await response.text();
    expect(text).not.toContain(pin);
    expect(text).not.toContain(token);
    expect(text).not.toContain('tokenHash');
    expect(
      (await call('/api/rewards/operator', { pin }, { Origin: 'https://attacker.test' })).status,
    ).toBe(403);
  });
  it('fails closed when the operator secret is missing', async () => {
    delete env.REWARDS_OPERATOR_PIN;
    expect((await call('/api/rewards/operator', { pin })).status).toBe(503);
    await save({ type: 'reward.put', value: reward }, 503);
    await save({ type: 'chore.put', value: { ...chore, stars: 0 } }, 200, false);
  });
  it('keeps zero-star chores unchanged without historical awards', async () => {
    await save({ type: 'chore.put', value: { ...chore, stars: 0 } });
    await complete();
    let state = await save({ type: 'chore.put', value: chore });
    await complete();
    state = await load();
    expect(state.starTransactions).toHaveLength(0);
    expect(state.choreAwards).toHaveLength(0);
    state = await complete('2026-09-20');
    expect(balance(state)).toBe(5);
  });
  it('awards once per recurring occurrence and retains undo/re-complete history', async () => {
    await save({ type: 'chore.put', value: chore });
    await complete();
    await complete();
    let state = await complete('2026-09-20');
    expect(balance(state)).toBe(10);
    expect(state.starTransactions).toHaveLength(2);
    state = await complete('2026-09-19', false);
    expect(balance(state)).toBe(5);
    expect(state.starTransactions[2].type).toBe('chore_reversal');
    await complete('2026-09-19', false);
    expect((await load()).starTransactions).toHaveLength(3);
    state = await complete();
    expect(balance(state)).toBe(10);
    expect(state.starTransactions).toHaveLength(4);
    expect(state.choreAwards).toHaveLength(3);
  });
  it('reverses the original amount and actor even when chore configuration changes', async () => {
    await save({ type: 'chore.put', value: chore });
    await complete();
    await save({ type: 'chore.put', value: { ...chore, stars: 20, memberIds: [] } });
    const state = await complete('2026-09-19', false);
    expect(balance(state)).toBe(0);
    expect(state.starTransactions.at(-1)?.amount).toBe(-5);
  });
  it('checks completion ownership and does not accept batched financial commands', async () => {
    await save({ type: 'chore.put', value: chore });
    await save({ type: 'chore.complete', id: chore.id, date: chore.dueDate, completed: true }, 400);
    await save({ type: 'member.put', value: { ...member, id: 'sam', name: 'Sam' } });
    await save(
      {
        type: 'chore.complete',
        id: chore.id,
        date: chore.dueDate,
        completed: true,
        memberId: 'sam',
      },
      400,
    );
    const response = await send({
      id: crypto.randomUUID(),
      revision: (await load()).household.revision,
      operations: [
        { type: 'stars.adjust', memberId: 'alex', amount: 10, note: 'A' },
        { type: 'stars.adjust', memberId: 'alex', amount: -5, note: 'B' },
      ],
    });
    expect(response.status).toBe(400);
    expect(balance(await load())).toBe(0);
  });
  it('blocks undo after stars were spent without changing the checkbox or ledger', async () => {
    await save({ type: 'chore.put', value: chore });
    await complete();
    await adjust(-5);
    const state = await save(
      { type: 'chore.complete', id: chore.id, date: chore.dueDate, completed: false },
      422,
    );
    expect(state.chores[0].completedDates).toEqual([chore.dueDate]);
    expect(state.starTransactions).toHaveLength(2);
  });
  it('records manual adjustments with reasons and rejects negative balances', async () => {
    expect(balance(await adjust(30))).toBe(30);
    expect(balance(await adjust(-10))).toBe(20);
    await save({ type: 'stars.adjust', memberId: 'alex', amount: -21, note: 'Correction' }, 422);
    const state = await load();
    expect(balance(state)).toBe(20);
    expect(state.starTransactions[0].note).toBe('Helped in the garden');
    expect(
      (
        await call('/api/mutations', {
          id: crypto.randomUUID(),
          revision: state.household.revision,
          operations: [{ type: 'stars.adjust', memberId: 'alex', amount: 5, note: '' }],
        })
      ).status,
    ).toBe(400);
  });
  it('creates, edits, deactivates and safely deletes rewards with relational eligibility', async () => {
    const initial = await save({ type: 'reward.put', value: reward });
    const assigned = await save({ type: 'reward.put', value: { ...reward, memberIds: ['alex'] } });
    expect(assigned.rewards[0].updatedAt).not.toBe(initial.rewards[0].updatedAt);
    expect(assigned.rewards[0].createdAt).toBe(initial.rewards[0].createdAt);
    let state = await save({
      type: 'reward.put',
      value: { ...reward, memberIds: ['alex'], name: 'Choose dinner', starCost: 15, active: false },
    });
    expect(state.rewards[0]).toMatchObject({
      name: 'Choose dinner',
      starCost: 15,
      active: false,
      memberIds: ['alex'],
    });
    const created = state.rewards[0].createdAt;
    await save({ type: 'reward.put', value: { ...reward, memberIds: [] } });
    expect((await load()).rewards[0].createdAt).toBe(created);
    state = await save({ type: 'reward.delete', id: 'dinner' });
    expect(state.rewards).toHaveLength(0);
  });
  it('checks eligibility, active state and sufficient balance before redeeming', async () => {
    await save({ type: 'member.put', value: { ...member, id: 'sam', name: 'Sam' } });
    await save({ type: 'reward.put', value: { ...reward, memberIds: ['sam'] } });
    await adjust(30);
    await save({ type: 'reward.redeem', id: 'r1', rewardId: 'dinner', memberId: 'alex' }, 422);
    await save({ type: 'reward.put', value: { ...reward, active: false } });
    await save({ type: 'reward.redeem', id: 'r2', rewardId: 'dinner', memberId: 'alex' }, 422);
    await save({ type: 'reward.put', value: { ...reward, starCost: 31 } });
    await save({ type: 'reward.redeem', id: 'r3', rewardId: 'dinner', memberId: 'alex' }, 422);
    expect((await load()).redemptions).toHaveLength(0);
  });
  it('redeems immediately, retries safely, and permits intentional reusable redemptions', async () => {
    await save({ type: 'reward.put', value: reward });
    await adjust(30);
    const body: Mutation = {
      id: crypto.randomUUID(),
      revision: (await load()).household.revision,
      operations: [{ type: 'reward.redeem', id: 'r1', rewardId: 'dinner', memberId: 'alex' }],
    };
    expect((await send(body, false)).status).toBe(200);
    expect((await send(body, false)).status).toBe(200);
    await save({ type: 'reward.redeem', id: 'r1', rewardId: 'dinner', memberId: 'alex' }, 409);
    let state = await load();
    expect(balance(state)).toBe(20);
    expect(state.redemptions).toHaveLength(1);
    state = await redeem('r2');
    expect(balance(state)).toBe(10);
    expect(state.redemptions).toHaveLength(2);
    await save({ type: 'reward.delete', id: 'dinner' }, 422);
    await save({ type: 'reward.put', value: { ...reward, reusable: false } }, 422);
  });
  it('allows one-time rewards once per member and preserves history', async () => {
    await save({ type: 'reward.put', value: { ...reward, reusable: false } });
    await adjust(30);
    await redeem('r1');
    await save({ type: 'reward.redeem', id: 'r2', rewardId: 'dinner', memberId: 'alex' }, 422);
    await save({ type: 'member.put', value: { ...member, id: 'sam', name: 'Sam' } });
    await save({ type: 'stars.adjust', memberId: 'sam', amount: 10, note: 'Bonus' });
    const state = await save({
      type: 'reward.redeem',
      id: 'r3',
      rewardId: 'dinner',
      memberId: 'sam',
    });
    expect(state.redemptions).toHaveLength(2);
  });
  it('requests without deducting, approves once at the quoted cost, and declines without spending', async () => {
    await save({ type: 'reward.put', value: { ...reward, requiresApproval: true } });
    await adjust(30);
    let state = await redeem('r1');
    expect(balance(state)).toBe(30);
    expect(state.redemptions[0].status).toBe('pending');
    await save(
      { type: 'reward.redeem', id: 'duplicate', rewardId: 'dinner', memberId: 'alex' },
      422,
    );
    await save({ type: 'reward.put', value: { ...reward, starCost: 20, requiresApproval: true } });
    state = await save({ type: 'reward.resolve', id: 'r1', approve: true });
    expect(balance(state)).toBe(20);
    expect(state.redemptions[0].status).toBe('redeemed');
    await save({ type: 'reward.resolve', id: 'r1', approve: true }, 422);
    await redeem('r2');
    state = await save({ type: 'reward.resolve', id: 'r2', approve: false });
    expect(balance(state)).toBe(20);
    expect(state.redemptions[1].status).toBe('declined');
  });
  it('rechecks balance and eligibility at approval, leaving failed requests pending', async () => {
    await save({ type: 'reward.put', value: { ...reward, requiresApproval: true } });
    await adjust(10);
    await redeem('r1');
    await adjust(-5);
    let state = await save({ type: 'reward.resolve', id: 'r1', approve: true }, 422);
    expect(state.redemptions[0].status).toBe('pending');
    expect(balance(state)).toBe(5);
    await adjust(5);
    await save({ type: 'reward.put', value: { ...reward, active: false, requiresApproval: true } });
    state = await save({ type: 'reward.resolve', id: 'r1', approve: true }, 422);
    expect(balance(state)).toBe(10);
    await save({ type: 'reward.resolve', id: 'r1', approve: false });
  });
  it('serializes concurrent spending and completion races through the household revision', async () => {
    await save({ type: 'reward.put', value: reward });
    await adjust(10);
    const revision = (await load()).household.revision;
    const results = await Promise.all(
      ['r1', 'r2'].map((id) =>
        send(
          {
            id: crypto.randomUUID(),
            revision,
            operations: [{ type: 'reward.redeem', id, rewardId: 'dinner', memberId: 'alex' }],
          },
          false,
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(balance(await load())).toBe(0);
    await save({ type: 'chore.put', value: chore });
    const version = (await load()).household.revision;
    const completions = await Promise.all(
      [1, 2].map(() =>
        send(
          {
            id: crypto.randomUUID(),
            revision: version,
            operations: [
              {
                type: 'chore.complete',
                id: 'dishes',
                date: chore.dueDate,
                memberId: 'alex',
                completed: true,
              },
            ],
          },
          false,
        ),
      ),
    );
    expect(completions.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(balance(await load())).toBe(5);
  });
  it('retains member/chore/reward references and rejects other-household identities', async () => {
    await save({ type: 'chore.put', value: chore });
    await complete();
    await save({ type: 'delete', entity: 'member', id: 'alex' }, 422);
    await save({ type: 'delete', entity: 'chore', id: 'dishes' }, 422);
    await db.batch([
      db.prepare("INSERT INTO households (id,name,timeZone) VALUES ('other','Other','UTC')"),
      db.prepare(
        "INSERT INTO members (household_id,id,name,initial,color,tint) VALUES ('other','outsider','Elsewhere','E','#123456','#eeeeee')",
      ),
    ]);
    await save({ type: 'stars.adjust', memberId: 'outsider', amount: 10, note: 'No' }, 400);
    await save({ type: 'reward.put', value: { ...reward, memberIds: ['outsider'] } }, 400);
    await expect(
      db.prepare("INSERT INTO reward_members VALUES ('home','missing','outsider')").run(),
    ).rejects.toThrow();
    expect((await load()).family.some((m) => m.id === 'outsider')).toBe(false);
  });
  it('rolls back every part of a failed batch and keeps all reads write-free', async () => {
    await save({ type: 'chore.put', value: chore });
    await db
      .prepare(
        `CREATE TRIGGER fail_award BEFORE INSERT ON star_transactions BEGIN SELECT RAISE(ABORT,'test failure'); END`,
      )
      .run();
    const before = await load();
    const response = await send({
      id: crypto.randomUUID(),
      revision: before.household.revision,
      operations: [
        {
          type: 'chore.complete',
          id: 'dishes',
          date: chore.dueDate,
          completed: true,
          memberId: 'alex',
        },
      ],
    });
    expect(response.status).toBe(503);
    const after = await load();
    expect(after).toEqual(before);
    const original = db.batch.bind(db);
    let writes = 0;
    db.batch = (async (statements: D1PreparedStatement[]) => {
      const results = await original(statements);
      writes += results.reduce((sum, r) => sum + r.meta.rows_written, 0);
      return results;
    }) as D1Database['batch'];
    await load();
    await load();
    expect(writes).toBe(0);
  });
  it('migrates an existing household without rewriting records or inventing awards', async () => {
    const oldRuntime = createDatabase();
    try {
      const old = (await oldRuntime.getD1Database('DB')) as unknown as D1Database;
      await migrate(old, '0004_google_sync_status.sql');
      await seed(old);
      await old.batch([
        old.prepare(
          "INSERT INTO google_connections (household_id,id,refresh_ciphertext,refresh_iv,encryption_version,scopes) VALUES ('home','connection','test-cipher','test-iv',1,'calendar.readonly')",
        ),
        old.prepare(
          "INSERT INTO calendar_sources VALUES ('home','google_source','Work','google','#123456')",
        ),
        old.prepare(
          "INSERT INTO google_calendars (household_id,google_id,source_id,name,color,enabled,privacy_mode,sync_token,projection_version) VALUES ('home','external','google_source','Work','#123456',1,'title','retained-token',1)",
        ),
        old.prepare(
          "INSERT INTO google_calendar_members SELECT 'home','google_source',id FROM members LIMIT 1",
        ),
      ]);
      await old
        .prepare(
          'INSERT INTO chore_completions(household_id,chore_id,date) SELECT household_id,id,dueDate FROM chores LIMIT 1',
        )
        .run();
      const tables = [
        'members',
        'events',
        'event_members',
        'chore_completions',
        'meals',
        'lists',
        'list_items',
        'google_connections',
        'google_calendars',
        'google_calendar_members',
      ];
      const snapshots = await Promise.all(
        tables.map((t) => old.prepare(`SELECT * FROM ${t}`).all()),
      );
      await applyMigration(old, '0005_rewards.sql');
      for (let i = 0; i < tables.length; i++)
        expect((await old.prepare(`SELECT * FROM ${tables[i]}`).all()).results).toEqual(
          snapshots[i].results,
        );
      await applyMigration(old, '0007_member_roles.sql');
      const state = await readState(old);
      expect(state.chores.every((c) => c.stars === 0)).toBe(true);
      expect(state.starTransactions).toEqual([]);
      expect(state.rewards).toEqual([]);
    } finally {
      await oldRuntime.dispose();
    }
  });
});
