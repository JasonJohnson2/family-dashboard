import { requireHousehold } from './household-auth';
import { ApiError, HOUSEHOLD_ID } from './database';
import { readJson } from './http';
import { z } from 'zod';

declare global {
  interface Env {
    REWARDS_OPERATOR_PIN?: string;
  }
}
const hash = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
export async function requireRewardOperator(request: Request, env: Env) {
  const householdSession = await requireHousehold(request, env);
  const token = request.headers.get('X-Reward-Operator') ?? '';
  const pin = env.REWARDS_OPERATOR_PIN;
  if (!pin || pin.length < 8)
    throw new ApiError(
      503,
      'Rewards management needs an operator PIN configured by the household owner.',
      'operator_setup',
    );
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new ApiError(
      403,
      'Unlock with the operator PIN to make this change.',
      'operator_required',
    );
  const session = await env.DB.prepare(
    'SELECT expiresAt FROM reward_operator_sessions WHERE household_id=? AND tokenHash=? AND householdSessionId=?',
  )
    .bind(HOUSEHOLD_ID, await hash(`${pin}:${token}`), householdSession.id)
    .first<{ expiresAt: number }>();
  if (!session || session.expiresAt <= Date.now())
    throw new ApiError(
      403,
      'Operator access expired. Unlock again with the PIN.',
      'operator_required',
    );
}
export async function rewardOperatorRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') throw new ApiError(405, 'Use POST.');
  const householdSession = await requireHousehold(request, env);
  const pin = env.REWARDS_OPERATOR_PIN;
  if (!pin || pin.length < 8)
    throw new ApiError(
      503,
      'Set the REWARDS_OPERATOR_PIN Cloudflare secret to at least 8 characters to enable management.',
      'operator_setup',
    );
  const input = z
    .object({ pin: z.string().min(1).max(128) })
    .strict()
    .safeParse(await readJson(request));
  if (!input.success) throw new ApiError(400, 'Enter your operator PIN.');
  const now = Date.now(),
    windowMs = 15 * 60_000;
  // One bounded household bucket prevents distributed PIN guessing. It is used
  // only on unlock attempts, never on household reads or normal mutations.
  const row = await env.DB.prepare(
    `INSERT INTO reward_pin_attempts (household_id,attempts,windowStart) VALUES (?,1,?)
    ON CONFLICT(household_id) DO UPDATE SET attempts=CASE WHEN windowStart<=? THEN 1 ELSE attempts+1 END,
    windowStart=CASE WHEN windowStart<=? THEN excluded.windowStart ELSE windowStart END WHERE attempts<5 OR windowStart<=? RETURNING attempts`,
  )
    .bind(HOUSEHOLD_ID, now, now - windowMs, now - windowMs, now - windowMs)
    .first<{ attempts: number }>();
  if (!row || row.attempts > 5)
    throw new ApiError(
      429,
      'Too many PIN attempts. Wait 15 minutes before trying again.',
      'operator_throttled',
    );
  const actual = await hash(pin),
    supplied = await hash(input.data.pin);
  let difference = 0;
  for (let i = 0; i < actual.length; i++)
    difference |= actual.charCodeAt(i) ^ supplied.charCodeAt(i);
  if (difference)
    throw new ApiError(403, 'That operator PIN was not accepted.', 'operator_required');
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const expiresAt = now + 15 * 60_000;
  await env.DB.prepare(
    `INSERT INTO reward_operator_sessions (household_id,tokenHash,expiresAt,householdSessionId) VALUES (?,?,?,?)
    ON CONFLICT(household_id) DO UPDATE SET tokenHash=excluded.tokenHash,expiresAt=excluded.expiresAt,householdSessionId=excluded.householdSessionId`,
  )
    .bind(HOUSEHOLD_ID, await hash(`${pin}:${token}`), expiresAt, householdSession.id)
    .run();
  return Response.json(
    { token, expiresAt },
    { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
  );
}
