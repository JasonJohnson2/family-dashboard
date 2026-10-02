import type { HouseholdState, Operation } from '../src/data/contracts';
import { alreadyRedeemed, eligibleFor, starBalance } from '../src/data/rewards';
import { ApiError, HOUSEHOLD_ID } from './database';

export function operatorRequired(state: HouseholdState, op: Operation) {
  if (['reward.put', 'reward.delete', 'reward.resolve', 'stars.adjust'].includes(op.type))
    return true;
  if (op.type === 'chore.put')
    return !!op.value.stars || !!state.chores.find((c) => c.id === op.value.id)?.stars;
  return (
    op.type === 'delete' &&
    op.entity === 'chore' &&
    !!state.chores.find((c) => c.id === op.id)?.stars
  );
}

export function validateRewards(state: HouseholdState, operations: Operation[]) {
  const financial = (op: Operation) =>
    op.type.startsWith('reward.') ||
    op.type === 'stars.adjust' ||
    (op.type === 'chore.complete' &&
      (!!state.chores.find((c) => c.id === op.id)?.stars ||
        state.choreAwards.some((a) => a.choreId === op.id && a.date === op.date && !a.reversedAt)));
  // Financial decisions use one confirmed revision. Disallow compound commands that
  // could spend a balance twice or change eligibility between validation and writing.
  if (operations.length > 1 && operations.some(financial))
    throw new ApiError(400, 'Save each star or reward action separately.');
  const member = (id: string) => {
    if (!state.family.some((m) => m.id === id))
      throw new ApiError(400, 'Choose an existing household member.');
  };
  const child = (id: string) => {
    member(id);
    if (state.family.find((m) => m.id === id)?.role !== 'child')
      throw new ApiError(
        422,
        'Only child members participate in Rewards and Stars.',
        'child_required',
      );
  };
  const enough = (id: string, amount: number) => {
    if (starBalance(state.starTransactions, id) < amount)
      throw new ApiError(
        422,
        'Not enough stars. The balance has changed; earn or adjust stars before trying again.',
        'insufficient_stars',
      );
  };
  for (const op of operations) {
    if (op.type === 'reward.put') {
      const old = state.rewards.find((r) => r.id === op.value.id);
      op.value.memberIds.forEach((id) => {
        member(id);
        // Retain dormant existing recipients without broadening a restricted reward.
        // They remain ineligible until classified as children again.
        if (!old?.memberIds.includes(id)) child(id);
      });
      if (
        old &&
        old.reusable !== op.value.reusable &&
        state.redemptions.some((r) => r.rewardId === old.id)
      )
        throw new ApiError(
          422,
          'Keep the repeat setting for rewards with request history. Create a new reward to change it.',
        );
    }
    if (op.type === 'reward.delete' && state.redemptions.some((r) => r.rewardId === op.id))
      throw new ApiError(422, 'This reward has history. Deactivate it instead.');
    if (op.type === 'stars.adjust') {
      child(op.memberId);
      if (op.amount < 0) enough(op.memberId, -op.amount);
    }
    if (op.type === 'reward.redeem') {
      child(op.memberId);
      if (state.redemptions.some((r) => r.id === op.id))
        throw new ApiError(409, 'This request has already been submitted.', 'already_submitted');
      const reward = state.rewards.find((r) => r.id === op.rewardId);
      if (
        !reward?.active ||
        !eligibleFor(
          reward,
          state.family.find((m) => m.id === op.memberId),
        )
      )
        throw new ApiError(422, 'This reward is not available to this member.');
      if (alreadyRedeemed(reward, op.memberId, state.redemptions))
        throw new ApiError(422, 'This one-time reward has already been redeemed.');
      if (
        state.redemptions.some(
          (r) => r.rewardId === reward.id && r.memberId === op.memberId && r.status === 'pending',
        )
      )
        throw new ApiError(422, 'A request for this reward is already waiting for approval.');
      enough(op.memberId, reward.starCost);
    }
    if (op.type === 'reward.resolve') {
      const request = state.redemptions.find((r) => r.id === op.id);
      if (!request || request.status !== 'pending')
        throw new ApiError(422, 'This request has already been resolved or no longer exists.');
      if (op.approve) {
        child(request.memberId);
        const reward = state.rewards.find((r) => r.id === request.rewardId)!;
        if (
          !reward.active ||
          !eligibleFor(
            reward,
            state.family.find((m) => m.id === request.memberId),
          ) ||
          alreadyRedeemed(reward, request.memberId, state.redemptions)
        )
          throw new ApiError(
            422,
            'This reward is no longer available. Decline the request instead.',
          );
        enough(request.memberId, request.starCost);
      }
    }
    if (op.type === 'chore.complete') {
      const chore = state.chores.find((c) => c.id === op.id);
      if (chore && op.completed && !chore.completedDates.includes(op.date) && chore.stars) {
        if (!op.memberId)
          throw new ApiError(400, 'Choose who completed this chore to award their stars.');
        member(op.memberId);
        if (chore.memberIds.length && !chore.memberIds.includes(op.memberId))
          throw new ApiError(400, 'Choose a member assigned to this chore.');
      }
      if (!op.completed) {
        const award = state.choreAwards.find(
          (a) => a.choreId === op.id && a.date === op.date && !a.reversedAt,
        );
        if (award) enough(award.memberId, award.amount);
      }
    }
    if (
      op.type === 'delete' &&
      op.entity === 'member' &&
      (state.starTransactions.some((t) => t.memberId === op.id) ||
        state.redemptions.some((r) => r.memberId === op.id))
    )
      throw new ApiError(
        422,
        'This member has reward history and cannot be deleted. Their history and balance must be preserved.',
      );
    if (
      op.type === 'delete' &&
      op.entity === 'chore' &&
      state.choreAwards.some((a) => a.choreId === op.id)
    )
      throw new ApiError(
        422,
        'This chore has star history. End its recurring schedule instead of deleting it.',
      );
  }
}

export function rewardStatements(
  op: Operation,
  state: HouseholdState,
  mutationId: string,
  gate: string,
  write: (sql: string, values: unknown[]) => unknown,
) {
  const now = new Date().toISOString();
  const insert = (table: string, record: Record<string, unknown>) => {
    const keys = Object.keys(record);
    write(
      `INSERT INTO ${table} (household_id,${keys.join(',')}) SELECT ?,${keys.map(() => '?').join(',')} WHERE ${gate}`,
      [HOUSEHOLD_ID, ...Object.values(record)],
    );
  };
  const ledger = (
    memberId: string,
    amount: number,
    type: string,
    note: string,
    links: Record<string, unknown> = {},
  ) =>
    insert('star_transactions', {
      id: mutationId,
      memberId,
      amount,
      type,
      note,
      createdAt: now,
      ...links,
    });
  switch (op.type) {
    case 'reward.put': {
      const { memberIds, ...reward } = op.value;
      const old = state.rewards.find((r) => r.id === reward.id);
      const fields = Object.keys(reward).filter((k) => k !== 'id');
      const values = fields.map((k) => {
        const value = reward[k as keyof typeof reward];
        return typeof value === 'boolean' ? Number(value) : value;
      });
      // An unchanged save does not rewrite the reward or its eligibility rows.
      if (!old)
        insert('rewards', {
          ...reward,
          active: Number(reward.active),
          reusable: Number(reward.reusable),
          requiresApproval: Number(reward.requiresApproval),
          createdAt: now,
          updatedAt: now,
        });
      else if (
        fields.some((k) => reward[k as keyof typeof reward] !== old[k as keyof typeof reward]) ||
        memberIds.length !== old.memberIds.length ||
        memberIds.some((id) => !old.memberIds.includes(id))
      )
        write(
          `UPDATE rewards SET ${fields.map((k) => `${k}=?`).join(',')},updatedAt=? WHERE household_id=? AND id=? AND ${gate}`,
          [...values, now, HOUSEHOLD_ID, reward.id],
        );
      const removed = old?.memberIds.filter((id) => !memberIds.includes(id)) ?? [];
      const added = memberIds.filter((id) => !old?.memberIds.includes(id));
      if (removed.length)
        write(
          `DELETE FROM reward_members WHERE household_id=? AND reward_id=? AND member_id IN (SELECT value FROM json_each(?)) AND ${gate}`,
          [HOUSEHOLD_ID, reward.id, JSON.stringify(removed)],
        );
      if (added.length)
        write(
          `INSERT INTO reward_members (household_id,reward_id,member_id) SELECT ?,?,value FROM json_each(?) WHERE ${gate}`,
          [HOUSEHOLD_ID, reward.id, JSON.stringify(added)],
        );
      break;
    }
    case 'reward.delete':
      write(`DELETE FROM rewards WHERE household_id=? AND id=? AND ${gate}`, [HOUSEHOLD_ID, op.id]);
      break;
    case 'stars.adjust':
      ledger(op.memberId, op.amount, 'manual_adjustment', op.note);
      break;
    case 'reward.redeem': {
      const r = state.rewards.find((r) => r.id === op.rewardId)!;
      insert('reward_redemptions', {
        id: op.id,
        rewardId: r.id,
        memberId: op.memberId,
        name: r.name,
        starCost: r.starCost,
        status: r.requiresApproval ? 'pending' : 'redeemed',
        oneTime: Number(!r.reusable),
        createdAt: now,
        resolvedAt: r.requiresApproval ? null : now,
      });
      if (!r.requiresApproval)
        ledger(op.memberId, -r.starCost, 'reward_redemption', `Redeemed ${r.name}`, {
          rewardId: r.id,
          redemptionId: op.id,
        });
      break;
    }
    case 'reward.resolve': {
      const r = state.redemptions.find((r) => r.id === op.id)!;
      write(
        `UPDATE reward_redemptions SET status=?,resolvedAt=? WHERE household_id=? AND id=? AND status='pending' AND ${gate}`,
        [op.approve ? 'redeemed' : 'declined', now, HOUSEHOLD_ID, op.id],
      );
      if (op.approve)
        ledger(r.memberId, -r.starCost, 'reward_redemption', `Approved ${r.name}`, {
          rewardId: r.rewardId,
          redemptionId: r.id,
        });
      break;
    }
    case 'chore.complete': {
      const chore = state.chores.find((c) => c.id === op.id)!;
      if (
        op.completed &&
        !chore.completedDates.includes(op.date) &&
        chore.stars &&
        state.family.find((m) => m.id === op.memberId)?.role === 'child'
      ) {
        insert('chore_star_awards', {
          id: mutationId,
          choreId: chore.id,
          date: op.date,
          memberId: op.memberId!,
          amount: chore.stars,
        });
        ledger(
          op.memberId!,
          chore.stars,
          'chore_completion',
          `Completed ${chore.title} (${op.date})`,
          { choreId: chore.id, choreCompletionId: mutationId },
        );
      } else if (!op.completed) {
        const award = state.choreAwards.find(
          (a) => a.choreId === op.id && a.date === op.date && !a.reversedAt,
        );
        if (award) {
          write(
            `UPDATE chore_star_awards SET reversedAt=? WHERE household_id=? AND id=? AND ${gate}`,
            [now, HOUSEHOLD_ID, award.id],
          );
          ledger(
            award.memberId,
            -award.amount,
            'chore_reversal',
            `Undid ${chore.title} (${op.date})`,
            { choreId: chore.id, choreCompletionId: award.id },
          );
        }
      }
      break;
    }
  }
}
