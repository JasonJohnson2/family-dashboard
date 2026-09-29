// Test fixtures only. Real D1 sessions pass through the production authorization gate.
import worker from '../worker/index';
import { digest, randomToken } from '../worker/credential';
const sessions = new WeakMap<D1Database, Promise<string>>();
export function testSession(db: D1Database) {
  let pending = sessions.get(db);
  if (!pending) {
    pending = (async () => {
      const token = randomToken();
      await db
        .prepare(
          "INSERT INTO household_credentials(household_id,verifier,version,updatedAt) VALUES ('home','fixture-only','fixture',?) ON CONFLICT(household_id) DO NOTHING",
        )
        .bind(Date.now())
        .run();
      await db
        .prepare(
          "INSERT INTO household_sessions(household_id,id,tokenHash,credentialVersion,name,trusted,createdAt,expiresAt) SELECT household_id,?,?,version,'Test browser',1,?,? FROM household_credentials WHERE household_id='home'",
        )
        .bind(crypto.randomUUID(), await digest(token), Date.now(), Date.now() + 180 * 86400000)
        .run();
      return `__Host-household=${token}`;
    })();
    sessions.set(db, pending);
  }
  return pending;
}
export function shareTestSession(from: D1Database, to: D1Database) {
  sessions.set(to, testSession(from));
}
export const authenticatedWorker = {
  async fetch(request: Request, env: Env) {
    const headers = new Headers(request.headers);
    headers.set(
      'Cookie',
      [await testSession(env.DB), headers.get('Cookie')].filter(Boolean).join('; '),
    );
    return worker.fetch(new Request(request, { headers }), env);
  },
};
