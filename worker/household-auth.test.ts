import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigration, createDatabase, migrate, seed } from '../scripts/test-database';
import worker from './index';
import { createVerifier, digest, verifyCredential } from './credential';
import { NORMAL_SECONDS, TRUSTED_SECONDS } from './household-auth';
import { readState } from './database';

const credential = 'test-only-household-passphrase-493827';
const origin = 'https://home.test';
const pin = 'test-only-48269173';
const verifier = await createVerifier(credential);
describe('Private household access on real D1', () => {
  let runtime: ReturnType<typeof createDatabase>, db: D1Database, env: Env;
  beforeEach(async () => {
    runtime = createDatabase();
    db = (await runtime.getD1Database('DB')) as unknown as D1Database;
    await migrate(db);
    await seed(db);
    env = {
      GOOGLE_APP_ORIGIN: origin,
      DB: db,
      ASSETS: { fetch: async () => new Response('public shell') } as Fetcher,
      HOUSEHOLD_BOOTSTRAP_VERIFIER: verifier,
      REWARDS_OPERATOR_PIN: pin,
      AUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await runtime.dispose();
  });
  const call = (path: string, body?: unknown, cookie = '', headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request(`${origin}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  async function login(trusted = true, supplied = credential) {
    const response = await call('auth/login', { credential: supplied, trusted, name: 'Kitchen' });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.headers.get('Set-Cookie')!.split(';')[0];
  }
  async function operator(cookie: string) {
    const response = await call('rewards/operator', { pin }, cookie);
    expect(response.status).toBe(200);
    return { 'X-Reward-Operator': ((await response.json()) as { token: string }).token };
  }
  it('denies direct access to every private route, including unknown routes and Google management', async () => {
    for (const path of [
      'household',
      'mutations',
      'calendar',
      'chores',
      'rewards',
      'meals',
      'lists',
      'members',
      'rewards/operator',
      'google/status',
      'google/connect',
      'google/calendars',
      'google/sync',
      'google/refresh',
      'google/disconnect',
      'auth/devices',
      'auth/revoke',
      'auth/credential',
      'missing',
    ]) {
      for (const body of [undefined, {}]) {
        const response = await call(path, body);
        expect(response.status, path).toBe(401);
        expect(await response.json()).toEqual({
          error: 'Household access is required.',
          code: 'auth_required',
        });
        expect(response.headers.get('Cache-Control')).toContain('no-store');
      }
    }
    expect(await (await worker.fetch(new Request(origin), env)).text()).toBe('public shell');
    const callback = await call('google/callback');
    expect(callback.ok).toBe(false);
    expect(await callback.text()).not.toMatch(/Jason|refresh_ciphertext|starTransactions/);
  });
  it('fails closed before setup, rejects wrong credentials generically and stores only a salted verifier', async () => {
    delete env.HOUSEHOLD_BOOTSTRAP_VERIFIER;
    const missing = await call('auth/login', { credential, trusted: true });
    env.HOUSEHOLD_BOOTSTRAP_VERIFIER = verifier;
    const wrong = await call('auth/login', { credential: 'wrong', trusted: true });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual(await wrong.json());
    expect(await db.prepare('SELECT * FROM household_credentials').first()).toBeNull();
    await login();
    const stored = await db
      .prepare('SELECT * FROM household_credentials')
      .first<{ verifier: string }>();
    expect(stored!.verifier).toBe(verifier);
    expect(JSON.stringify(stored)).not.toContain(credential);
    expect(await verifyCredential(credential, stored!.verifier)).toBe(true);
    expect(await createVerifier(credential)).not.toBe(verifier);
    env.HOUSEHOLD_BOOTSTRAP_VERIFIER = await createVerifier(
      'replacement-bootstrap-cannot-take-over',
    );
    expect(
      (
        await call('auth/login', {
          credential: 'replacement-bootstrap-cannot-take-over',
          trusted: true,
        })
      ).status,
    ).toBe(401);
    await login();
  });
  it('creates random hashed sessions with secure host cookies and distinct normal/trusted lifetimes', async () => {
    const tokens: string[] = [];
    for (const trusted of [false, true]) {
      const response = await call('auth/login', { credential, trusted });
      const cookie = response.headers.get('Set-Cookie')!;
      expect(cookie).toContain('__Host-household=');
      expect(cookie).toContain('; Secure');
      expect(cookie).toContain('; HttpOnly');
      expect(cookie).toContain('; SameSite=Lax');
      expect(cookie).toContain('; Path=/');
      expect(cookie).not.toContain('Domain=');
      expect(cookie).toContain(`Max-Age=${trusted ? TRUSTED_SECONDS : NORMAL_SECONDS}`);
      const token = cookie.split(';')[0].split('=')[1];
      tokens.push(token);
      const session = await db
        .prepare('SELECT * FROM household_sessions WHERE tokenHash=?')
        .bind(await digest(token))
        .first<{ expiresAt: number; createdAt: number }>();
      expect(session).toBeTruthy();
      expect(JSON.stringify(session)).not.toContain(token);
      expect(session!.expiresAt - session!.createdAt).toBe(
        (trusted ? TRUSTED_SECONDS : NORMAL_SECONDS) * 1000,
      );
      expect(await response.text()).not.toContain(token);
      expect((await call('household', undefined, cookie.split(';')[0])).status).toBe(200);
    }
    expect(tokens[0]).not.toBe(tokens[1]);
  });
  it('rejects malformed, expired, revoked, and other-household sessions', async () => {
    expect((await call('household', undefined, '__Host-household=bad')).status).toBe(401);
    let cookie = await login();
    await db.prepare('UPDATE household_sessions SET expiresAt=0').run();
    expect((await call('household', undefined, cookie)).status).toBe(401);
    cookie = await login();
    await db.prepare('UPDATE household_sessions SET revokedAt=1').run();
    expect((await call('household', undefined, cookie)).status).toBe(401);
    cookie = await login();
    await db
      .prepare(
        "INSERT INTO households (id,name,timeZone,revision) VALUES ('other','Private','UTC',0)",
      )
      .run();
    await db
      .prepare("INSERT INTO household_credentials VALUES ('other','fixture','foreign',0)")
      .run();
    await db
      .prepare("UPDATE household_sessions SET household_id='other',credentialVersion='foreign'")
      .run();
    expect((await call('household', undefined, cookie)).status).toBe(401);
  });
  it('logs out on the server and clears the cookie', async () => {
    const cookie = await login();
    const result = await call('auth/logout', {}, cookie);
    expect(result.status).toBe(200);
    expect(result.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await call('household', undefined, cookie)).status).toBe(401);
  });
  it('requires both household access and the session-bound operator PIN for device management', async () => {
    const first = await login(),
      second = await login();
    expect((await call('auth/devices', undefined, first)).status).toBe(403);
    const headers = await operator(first);
    expect((await call('auth/devices', undefined, second, headers)).status).toBe(403);
    expect((await call('auth/devices', undefined, '', headers)).status).toBe(401);
    const response = await call('auth/devices', undefined, first, headers);
    const text = await response.text();
    expect(text).not.toMatch(/tokenHash|credentialVersion|verifier/);
    const devices = JSON.parse(text).devices as { id: string; current: boolean }[];
    expect(devices).toHaveLength(2);
    const target = devices.find((d) => !d.current)!;
    expect((await call('auth/revoke', { id: target.id }, first)).status).toBe(403);
    expect((await call('auth/revoke', { id: target.id }, first, headers)).status).toBe(200);
    expect((await call('household', undefined, second)).status).toBe(401);
    expect((await call('household', undefined, first)).status).toBe(200);
  });
  it('changes the credential atomically, invalidates all sessions and operator access, and cannot reuse bootstrap', async () => {
    const first = await login(),
      second = await login();
    const headers = await operator(first),
      next = 'new-random-household-passphrase-739421';
    expect((await call('auth/credential', { credential: next }, first)).status).toBe(403);
    expect((await call('auth/credential', { credential: '1234' }, first, headers)).status).toBe(
      400,
    );
    expect((await call('auth/credential', { credential: next }, first, headers)).status).toBe(200);
    for (const cookie of [first, second])
      expect((await call('household', undefined, cookie)).status).toBe(401);
    expect((await call('auth/login', { credential, trusted: true })).status).toBe(401);
    const fresh = await login(true, next);
    expect((await call('auth/devices', undefined, fresh, headers)).status).toBe(403);
    expect(await db.prepare('SELECT * FROM reward_operator_sessions').first()).toBeNull();
    expect(
      JSON.stringify(await db.prepare('SELECT * FROM household_credentials').first()),
    ).not.toContain(next);
  });
  it('keeps ordinary actions available but Rewards privileges locked', async () => {
    await db.prepare("UPDATE members SET role='child' WHERE household_id='home'").run();
    const cookie = await login();
    const state = await readState(db);
    const mutation = (operations: unknown[]) => ({
      id: crypto.randomUUID(),
      revision: state.household.revision,
      operations,
    });
    const paid = await call(
      'mutations',
      mutation([{ type: 'stars.adjust', memberId: state.family[0].id, amount: 5, note: 'Bonus' }]),
      cookie,
    );
    expect(paid.status).toBe(403);
    const list = state.lists[0];
    expect(
      (
        await call(
          'mutations',
          mutation([
            { type: 'item.complete', listId: list.id, id: list.items[0].id, completed: true },
          ]),
          cookie,
        )
      ).status,
    ).toBe(200);
  });
  it('rejects non-HTTPS deployment login before processing credentials', async () => {
    const response = await worker.fetch(
      new Request('http://home.test/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, trusted: true }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await db.prepare('SELECT * FROM household_credentials').first()).toBeNull();
    expect(await db.prepare('SELECT * FROM household_login_attempts').first()).toBeNull();
  });
  it('rejects cross-site login, logout, credential changes and household mutations', async () => {
    const cookie = await login();
    for (const path of [
      'auth/login',
      'auth/logout',
      'auth/credential',
      'auth/revoke',
      'mutations',
      'rewards/operator',
      'google/refresh',
    ]) {
      expect((await call(path, {}, cookie, { Origin: 'https://evil.test' })).status).toBe(403);
      expect((await call(path, {}, cookie, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    }
    const response = await worker.fetch(
      new Request(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      }),
      env,
    );
    expect(response.status).toBe(415);
  });
  it('limits at the edge before D1 and caps durable attempts without writes after cooldown starts', async () => {
    env.AUTH_RATE_LIMITER = { limit: async () => ({ success: false }) };
    expect((await call('auth/login', { credential, trusted: true })).status).toBe(429);
    expect(await db.prepare('SELECT * FROM household_login_attempts').first()).toBeNull();
    env.AUTH_RATE_LIMITER = { limit: async () => ({ success: true }) };
    for (let i = 0; i < 20; i++)
      expect((await call('auth/login', { credential: 'wrong', trusted: true })).status).toBe(401);
    await db
      .prepare(
        "CREATE TRIGGER prevent_attempt_write BEFORE UPDATE ON household_login_attempts BEGIN SELECT RAISE(ABORT,'unexpected write'); END",
      )
      .run();
    for (let i = 0; i < 3; i++)
      expect((await call('auth/login', { credential, trusted: true })).status).toBe(429);
    await db.prepare('DROP TRIGGER prevent_attempt_write').run();
    await db.prepare('UPDATE household_login_attempts SET windowStart=0').run();
    await login();
    Reflect.deleteProperty(env, 'AUTH_RATE_LIMITER');
    expect((await call('auth/login', { credential, trusted: true })).status).toBe(503);
  });
  it('performs zero session/credential writes during repeated authenticated reads and excludes auth secrets from JSON', async () => {
    const cookie = await login();
    for (const table of ['household_sessions', 'household_credentials', 'household_login_attempts'])
      for (const action of ['INSERT', 'UPDATE', 'DELETE'])
        await db
          .prepare(
            `CREATE TRIGGER no_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'read wrote auth data'); END`,
          )
          .run();
    for (let i = 0; i < 3; i++) {
      for (const path of ['household', 'auth/session', 'google/refresh']) {
        const response = await call(path, undefined, cookie);
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(await response.text()).not.toMatch(
          /pbkdf2|tokenHash|credentialVersion|test-only|GOOGLE_ADMIN_KEY/,
        );
      }
    }
  });
  it('migrates the existing production-shaped household without changing its data', async () => {
    const previous = createDatabase();
    try {
      const old = (await previous.getD1Database('DB')) as unknown as D1Database;
      await migrate(old, '0005_rewards.sql');
      await seed(old);
      // Snapshot the original tables directly: current state types require later migrations.
      const tables = [
        'households',
        'members',
        'events',
        'chores',
        'meals',
        'lists',
        'list_items',
        'rewards',
        'star_transactions',
        'reward_redemptions',
      ];
      const snapshot = () =>
        Promise.all(
          tables.map(async (t) => (await old.prepare(`SELECT * FROM ${t}`).all()).results),
        );
      const before = await snapshot();
      await applyMigration(old, '0006_household_access.sql');
      expect(await snapshot()).toEqual(before);
      expect(await old.prepare('SELECT * FROM household_credentials').first()).toBeNull();
      expect(await old.prepare('SELECT * FROM household_sessions').first()).toBeNull();
    } finally {
      await previous.dispose();
    }
  });
});
