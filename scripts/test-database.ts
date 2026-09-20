import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { seedStatements } from './seed-data';

export function createDatabase(persist: string | boolean = false) {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test database");}}',
      compatibilityDate: '2026-09-19',
      d1Databases: ['DB'],
      resourcePersistencePath: typeof persist === 'string' ? persist : undefined,
    }),
  );
}
export async function migrate(db: D1Database) {
  for (const file of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(`migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
}
export async function seed(db: D1Database, mode: 'starter' | 'demo' = 'demo') {
  const statements = seedStatements(mode);
  for (let i = 0; i < statements.length; i += 20)
    await db.batch(statements.slice(i, i + 20).map((sql) => db.prepare(sql)));
}
