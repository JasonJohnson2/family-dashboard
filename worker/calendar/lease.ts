import { ApiError, HOUSEHOLD_ID } from '../database';
export interface Lease {
  db: D1Database;
  owner: string;
  provider: 'google' | 'icloud';
}
export async function withLease<T>(
  db: D1Database,
  fn: (lease: Lease) => Promise<T>,
  provider: 'google' | 'icloud' = 'google',
) {
  const owner = crypto.randomUUID(),
    now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO ${provider}_operation_locks (household_id,owner,expires_at) VALUES (?,?,?) ON CONFLICT(household_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE ${provider}_operation_locks.expires_at<=?`,
    )
    .bind(HOUSEHOLD_ID, owner, now + 120000, now)
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(
      409,
      'Another calendar operation is running. Try again shortly.',
      `${provider}_busy`,
    );
  try {
    return await fn({ db, owner, provider });
  } finally {
    await db
      .prepare(`DELETE FROM ${provider}_operation_locks WHERE household_id=? AND owner=?`)
      .bind(HOUSEHOLD_ID, owner)
      .run();
  }
}
export async function commit(lease: Lease, statements: D1PreparedStatement[], revise = true) {
  const { db, owner, provider } = lease;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO ${provider}_commit_guards (owner,valid) VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM ${provider}_operation_locks WHERE household_id=? AND owner=? AND expires_at>?) THEN 1 ELSE 0 END)`,
        )
        .bind(owner, HOUSEHOLD_ID, owner, Date.now()),
      ...statements,
      ...(revise
        ? [db.prepare('UPDATE households SET revision=revision+1 WHERE id=?').bind(HOUSEHOLD_ID)]
        : []),
      db.prepare(`DELETE FROM ${provider}_commit_guards WHERE owner=?`).bind(owner),
    ]);
  } catch {
    throw new ApiError(
      503,
      'Calendar changes could not be committed. Nothing in this batch was saved; retry.',
      `${provider}_commit`,
    );
  }
}
