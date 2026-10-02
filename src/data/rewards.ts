import { z } from 'zod';
import type { FamilyMember } from '../types';
export const childMembers = (family: FamilyMember[]) => family.filter((m) => m.role === 'child');

const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const rewardIcons = ['🎁', '🍕', '🎮', '🎬', '🍦', '🎨', '⛺', '📚', '🧩', '🌟'] as const;
export const rewardSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500),
    icon: z.enum(rewardIcons),
    starCost: z.number().int().min(1).max(100000),
    active: z.boolean(),
    reusable: z.boolean(),
    requiresApproval: z.boolean(),
    memberIds: z
      .array(id)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const redemptionSchema = z.object({
  id,
  rewardId: id,
  memberId: id,
  name: z.string(),
  starCost: z.number().int().positive(),
  status: z.enum(['pending', 'redeemed', 'declined']),
  oneTime: z.boolean(),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
});
export const transactionSchema = z.object({
  id,
  memberId: id,
  amount: z.number().int(),
  type: z.enum(['chore_completion', 'chore_reversal', 'reward_redemption', 'manual_adjustment']),
  choreId: id.optional(),
  choreCompletionId: id.optional(),
  rewardId: id.optional(),
  redemptionId: id.optional(),
  note: z.string(),
  createdAt: z.string(),
});
export const awardSchema = z.object({
  id,
  choreId: id,
  date: z.string(),
  memberId: id,
  amount: z.number().int(),
  reversedAt: z.string().optional(),
});
export const rewardOperations = [
  z.object({ type: z.literal('reward.put'), value: rewardSchema }).strict(),
  z.object({ type: z.literal('reward.delete'), id }).strict(),
  z
    .object({
      type: z.literal('stars.adjust'),
      memberId: id,
      amount: z
        .number()
        .int()
        .min(-100000)
        .max(100000)
        .refine((n) => n !== 0),
      note: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ type: z.literal('reward.redeem'), id, rewardId: id, memberId: id }).strict(),
  z.object({ type: z.literal('reward.resolve'), id, approve: z.boolean() }).strict(),
] as const;
export type Reward = z.infer<typeof rewardSchema>;
export type Redemption = z.infer<typeof redemptionSchema>;
export type StarTransaction = z.infer<typeof transactionSchema>;
export const starBalance = (transactions: StarTransaction[], memberId: string) =>
  transactions.filter((t) => t.memberId === memberId).reduce((sum, t) => sum + t.amount, 0);
export const eligibleFor = (reward: Reward, member: FamilyMember | undefined) =>
  member?.role === 'child' && (!reward.memberIds.length || reward.memberIds.includes(member.id));
export const alreadyRedeemed = (reward: Reward, memberId: string, redemptions: Redemption[]) =>
  !reward.reusable &&
  redemptions.some(
    (r) => r.rewardId === reward.id && r.memberId === memberId && r.status === 'redeemed',
  );
