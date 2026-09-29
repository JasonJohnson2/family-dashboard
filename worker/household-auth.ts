import { z } from 'zod';
import { ApiError, HOUSEHOLD_ID } from './database';
import { readJson } from './http';
import {
  createVerifier,
  digest,
  randomToken,
  validCredential,
  validVerifier,
  verifyCredential,
} from './credential';
import { requireRewardOperator } from './reward-operator';

declare global {
  interface Env {
    HOUSEHOLD_BOOTSTRAP_VERIFIER?: string;
  }
}
export const NORMAL_SECONDS = 12 * 60 * 60;
export const TRUSTED_SECONDS = 180 * 24 * 60 * 60;
export interface HouseholdSession {
  id: string;
  name: string;
  trusted: number;
  createdAt: number;
  expiresAt: number;
  credentialVersion: string;
}
export const authJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
const denied = () => new ApiError(401, 'Household access is required.', 'auth_required');
function cookieName(request: Request) {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return '__Host-household';
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'household_local';
  throw new ApiError(400, 'Use HTTPS to access your household.');
}
export function sessionCookie(request: Request, token: string, seconds: number) {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function requireHousehold(
  request: Request,
  env: Pick<Env, 'DB'>,
): Promise<HouseholdSession> {
  const token =
    (request.headers.get('Cookie') ?? '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName(request)}=`))
      ?.split('=')[1] ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw denied();
  const session = await env.DB.prepare(
    `SELECT s.id,s.name,s.trusted,s.createdAt,s.expiresAt,s.credentialVersion
    FROM household_sessions s JOIN household_credentials c ON c.household_id=s.household_id AND c.version=s.credentialVersion
    WHERE s.household_id=? AND s.tokenHash=? AND s.revokedAt IS NULL AND s.expiresAt>?`,
  )
    .bind(HOUSEHOLD_ID, await digest(token), Date.now())
    .first<HouseholdSession>();
  if (!session) throw denied();
  return session;
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    throw new ApiError(403, 'Use the dashboard to make this change.', 'origin');
}
async function throttle(request: Request, env: Env) {
  // Native edge limiter avoids database traffic for repeated requests from one IP.
  if (!env.AUTH_RATE_LIMITER)
    throw new ApiError(503, 'Household access is temporarily unavailable.');
  const { success } = await env.AUTH_RATE_LIMITER.limit({
    key: `login:${request.headers.get('CF-Connecting-IP') ?? 'local'}`,
  });
  if (!success)
    throw new ApiError(429, 'Please wait before trying household access again.', 'auth_throttled');
  // A durable household-wide ceiling also bounds distributed guessing across locations.
  // Only the first 20 attempts per 15 minutes write; rejected attempts change zero rows.
  const now = Date.now(),
    cutoff = now - 15 * 60_000;
  const row = await env.DB.prepare(
    `INSERT INTO household_login_attempts (household_id,attempts,windowStart) VALUES (?,1,?)
    ON CONFLICT(household_id) DO UPDATE SET attempts=CASE WHEN windowStart<=? THEN 1 ELSE attempts+1 END,
    windowStart=CASE WHEN windowStart<=? THEN excluded.windowStart ELSE windowStart END
    WHERE attempts<20 OR windowStart<=? RETURNING attempts`,
  )
    .bind(HOUSEHOLD_ID, now, cutoff, cutoff, cutoff)
    .first();
  if (!row)
    throw new ApiError(
      429,
      'Please wait 15 minutes before trying household access again.',
      'auth_throttled',
    );
}
async function login(request: Request, env: Env) {
  await throttle(request, env);
  const parsed = z
    .object({
      credential: z.string().min(1).max(128),
      trusted: z.boolean(),
      name: z.string().trim().max(80).optional(),
    })
    .strict()
    .safeParse(await readJson(request));
  if (!parsed.success) throw new ApiError(401, 'Household access was not accepted.', 'auth_failed');
  const row = await env.DB.prepare(
    'SELECT verifier,version FROM household_credentials WHERE household_id=?',
  )
    .bind(HOUSEHOLD_ID)
    .first<{ verifier: string; version: string }>();
  const verifier = row?.verifier ?? env.HOUSEHOLD_BOOTSTRAP_VERIFIER ?? '';
  if (!validVerifier(verifier) || !(await verifyCredential(parsed.data.credential, verifier)))
    throw new ApiError(401, 'Household access was not accepted.', 'auth_failed');
  const now = Date.now(),
    version = row?.version ?? crypto.randomUUID(),
    token = randomToken(),
    id = crypto.randomUUID();
  const seconds = parsed.data.trusted ? TRUSTED_SECONDS : NORMAL_SECONDS;
  const result = await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO household_credentials (household_id,verifier,version,updatedAt) VALUES (?,?,?,?) ON CONFLICT(household_id) DO NOTHING',
    ).bind(HOUSEHOLD_ID, verifier, version, now),
    env.DB.prepare(
      'DELETE FROM household_sessions WHERE household_id=? AND (expiresAt<=? OR revokedAt IS NOT NULL)',
    ).bind(HOUSEHOLD_ID, now),
    env.DB.prepare(
      `INSERT INTO household_sessions (household_id,id,tokenHash,credentialVersion,name,trusted,createdAt,expiresAt)
      SELECT household_id,?, ?,version,?,?,?,? FROM household_credentials WHERE household_id=? AND verifier=? ${row ? 'AND version=?' : ''}`,
    ).bind(
      id,
      await digest(token),
      parsed.data.name || (parsed.data.trusted ? 'Trusted device' : 'Household browser'),
      parsed.data.trusted ? 1 : 0,
      now,
      now + seconds * 1000,
      HOUSEHOLD_ID,
      verifier,
      ...(row ? [version] : []),
    ),
  ]);
  if (result.at(-1)?.meta.changes !== 1)
    throw new ApiError(401, 'Household access was not accepted.', 'auth_failed');
  return authJson({ authenticated: true }, 200, {
    'Set-Cookie': sessionCookie(request, token, seconds),
  });
}
export async function authRoute(request: Request, env: Env) {
  cookieName(request); // Reject insecure non-loopback access before accepting a credential.
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET') sameOrigin(request);
  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  const session = await requireHousehold(request, env);
  if (path === '/api/auth/session' && request.method === 'GET')
    return authJson({
      authenticated: true,
      expiresAt: session.expiresAt,
      trusted: !!session.trusted,
    });
  if (path === '/api/auth/logout' && request.method === 'POST') {
    await readJson(request);
    await env.DB.prepare(
      'UPDATE household_sessions SET revokedAt=? WHERE household_id=? AND id=? AND revokedAt IS NULL',
    )
      .bind(Date.now(), HOUSEHOLD_ID, session.id)
      .run();
    return authJson({ authenticated: false }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }
  await requireRewardOperator(request, env);
  if (path === '/api/auth/devices' && request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT id,name,trusted,createdAt,expiresAt FROM household_sessions WHERE household_id=? AND revokedAt IS NULL AND expiresAt>? AND credentialVersion=? ORDER BY createdAt DESC',
    )
      .bind(HOUSEHOLD_ID, Date.now(), session.credentialVersion)
      .all();
    return authJson({ devices: rows.results.map((r) => ({ ...r, current: r.id === session.id })) });
  }
  if (path === '/api/auth/revoke' && request.method === 'POST') {
    const parsed = z
      .object({ id: z.string().uuid() })
      .strict()
      .safeParse(await readJson(request));
    if (!parsed.success) throw new ApiError(400, 'Choose a device.');
    await env.DB.prepare(
      'UPDATE household_sessions SET revokedAt=? WHERE household_id=? AND id=? AND revokedAt IS NULL',
    )
      .bind(Date.now(), HOUSEHOLD_ID, parsed.data.id)
      .run();
    return authJson({ revoked: true, current: parsed.data.id === session.id });
  }
  if (path === '/api/auth/credential' && request.method === 'POST') {
    const parsed = z
      .object({ credential: z.string().refine(validCredential) })
      .strict()
      .safeParse(await readJson(request));
    if (!parsed.success)
      throw new ApiError(400, 'Use a strong household credential of 20–128 characters.');
    const verifier = await createVerifier(parsed.data.credential),
      version = crypto.randomUUID(),
      now = Date.now();
    const result = await env.DB.batch([
      env.DB.prepare(
        `UPDATE household_credentials SET verifier=?,version=?,updatedAt=? WHERE household_id=? AND version=?
        AND EXISTS (SELECT 1 FROM household_sessions WHERE household_id=? AND id=? AND revokedAt IS NULL AND expiresAt>?)`,
      ).bind(
        verifier,
        version,
        now,
        HOUSEHOLD_ID,
        session.credentialVersion,
        HOUSEHOLD_ID,
        session.id,
        now,
      ),
      env.DB.prepare(
        'DELETE FROM reward_operator_sessions WHERE household_id=? AND EXISTS (SELECT 1 FROM household_credentials WHERE household_id=? AND version=?)',
      ).bind(HOUSEHOLD_ID, HOUSEHOLD_ID, version),
    ]);
    if (result[0].meta.changes !== 1) throw denied();
    // Session versions invalidate every device atomically, including this one and OAuth starts.
    return authJson({ changed: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }
  throw new ApiError(404, 'API endpoint not found.');
}
