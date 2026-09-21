import { z } from 'zod';
import { ApiError, HOUSEHOLD_ID } from '../database';
import { decryptToken, encryptToken, encryptionKey, hash, randomToken } from './crypto';
import { commit, connection, disconnectStatements, withLease } from './storage';
import type { GoogleEnv } from './types';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];
const PRODUCTION_ORIGIN = 'https://family-dashboard.jjayson400.workers.dev';
export function appOrigin(env: GoogleEnv) {
  const value = env.GOOGLE_APP_ORIGIN ?? PRODUCTION_ORIGIN;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(503, 'Invalid Google application origin.', 'google_configuration');
  }
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  )
    throw new ApiError(503, 'Invalid Google application origin.', 'google_configuration');
  return url.origin;
}
export async function configured(env: GoogleEnv) {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_ADMIN_KEY ||
    env.GOOGLE_ADMIN_KEY.length < 32
  )
    throw new ApiError(
      503,
      'Google Calendar is not configured. Set the documented Worker secrets.',
      'google_configuration',
    );
  await encryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}
export async function authorizeManagement(request: Request, env: GoogleEnv) {
  if (!env.GOOGLE_ADMIN_KEY || env.GOOGLE_ADMIN_KEY.length < 32)
    throw new ApiError(503, 'Google management is not configured.', 'google_configuration');
  const supplied = request.headers.get('Authorization') ?? '';
  if ((await hash(supplied)) !== (await hash(`Bearer ${env.GOOGLE_ADMIN_KEY}`)))
    throw new ApiError(401, 'Google management authorization is required.', 'google_unauthorized');
  const origin = request.headers.get('Origin');
  if (
    (origin && origin !== appOrigin(env)) ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    throw new ApiError(403, 'Use the configured dashboard origin.', 'google_origin');
}
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
export async function tokenRequest(env: GoogleEnv, params: Record<string, string>) {
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...params,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
      }),
    });
  } catch {
    throw new ApiError(502, 'Google could not be reached. Try again.', 'google_unavailable');
  }
  if (!response.ok)
    throw new ApiError(
      502,
      'Google authorization failed. Reconnect if access was revoked or expired.',
      'google_token',
    );
  try {
    const result = tokenSchema.parse(await response.json());
    if (result.scope && !SCOPES.every((s) => result.scope!.split(' ').includes(s)))
      throw new Error();
    return result;
  } catch {
    throw new ApiError(502, 'Google did not grant the required read-only access.', 'google_scopes');
  }
}
function cookieName(env: GoogleEnv) {
  return appOrigin(env).startsWith('https:') ? '__Host-google_oauth' : 'google_oauth';
}
export function stateCookie(env: GoogleEnv, value: string, maxAge = 600) {
  return `${cookieName(env)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appOrigin(env).startsWith('https:') ? '; Secure' : ''}`;
}
export async function connect(request: Request, env: GoogleEnv) {
  await configured(env);
  if (new URL(request.url).origin !== appOrigin(env))
    throw new ApiError(403, 'Open the configured dashboard origin to connect.', 'google_origin');
  if (await connection(env.DB))
    throw new ApiError(
      409,
      'Disconnect the current Google account before connecting another.',
      'google_connected',
    );
  const state = randomToken(),
    browser = randomToken(),
    verifier = randomToken();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM google_oauth_states WHERE expires_at<=? OR household_id=?').bind(
      Date.now(),
      HOUSEHOLD_ID,
    ),
    env.DB.prepare(
      'INSERT INTO google_oauth_states (state_hash,household_id,browser_hash,verifier,expires_at) VALUES (?,?,?,?,?)',
    ).bind(await hash(state), HOUSEHOLD_ID, await hash(browser), verifier, Date.now() + 600000),
  ]);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${appOrigin(env)}/api/google/callback`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return Response.json(
    { authorizationUrl: url.toString() },
    {
      headers: {
        'Set-Cookie': stateCookie(env, browser),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}
export async function callback(request: Request, env: GoogleEnv) {
  await configured(env);
  const url = new URL(request.url);
  if (url.origin !== appOrigin(env))
    throw new ApiError(403, 'Invalid callback origin.', 'google_origin');
  const state = url.searchParams.get('state') ?? '';
  const browser =
    (request.headers.get('Cookie') ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName(env)}=`))
      ?.split('=')[1] ?? '';
  if (!/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(browser))
    throw new ApiError(
      400,
      'The Google connection request is invalid or expired. Start again.',
      'google_state',
    );
  // DELETE RETURNING validates and consumes in a single statement, even on a denied callback.
  const row = await env.DB.prepare(
    'DELETE FROM google_oauth_states WHERE state_hash=? AND household_id=? AND browser_hash=? AND expires_at>? RETURNING verifier',
  )
    .bind(await hash(state), HOUSEHOLD_ID, await hash(browser), Date.now())
    .first<{ verifier: string }>();
  if (!row)
    throw new ApiError(
      400,
      'The Google connection request is invalid, expired, or already used. Start again.',
      'google_state',
    );
  if (url.searchParams.has('error'))
    throw new ApiError(
      400,
      'Google access was not granted. You can connect again when ready.',
      'google_denied',
    );
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096)
    throw new ApiError(
      400,
      'Google did not return an authorization code. Start again.',
      'google_code',
    );
  await withLease(env.DB, async (lease) => {
    if (await connection(env.DB))
      throw new ApiError(409, 'A Google account is already connected.', 'google_connected');
    const token = await tokenRequest(env, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${appOrigin(env)}/api/google/callback`,
      code_verifier: row.verifier,
    });
    if (!token.refresh_token)
      throw new ApiError(
        400,
        'Google did not provide offline access. Remove this app from Google account permissions, then connect again.',
        'google_refresh_missing',
      );
    const id = crypto.randomUUID();
    const encrypted = await encryptToken(token.refresh_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY, id);
    await commit(lease, [
      env.DB.prepare(
        'INSERT INTO google_connections (household_id,id,refresh_ciphertext,refresh_iv,encryption_version,scopes) VALUES (?,?,?,?,?,?)',
      ).bind(
        HOUSEHOLD_ID,
        id,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.version,
        token.scope ?? SCOPES.join(' '),
      ),
    ]);
  });
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${appOrigin(env)}/#calendar`,
      'Set-Cookie': stateCookie(env, '', 0),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
export async function accessToken(env: GoogleEnv) {
  await configured(env);
  const stored = await connection(env.DB);
  if (!stored) throw new ApiError(409, 'Connect Google before syncing.', 'google_not_connected');
  const refresh = await decryptToken(
    stored.refresh_ciphertext,
    stored.refresh_iv,
    stored.encryption_version,
    env.GOOGLE_TOKEN_ENCRYPTION_KEY,
    stored.id,
  );
  // Access tokens live only for this request. Each operation starts with a fresh token.
  return (await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh }))
    .access_token;
}
export async function disconnect(env: GoogleEnv) {
  await withLease(env.DB, async (lease) => commit(lease, await disconnectStatements(env.DB)));
}
