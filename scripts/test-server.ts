// Local browser-test harness only. This file is not part of the deployed Worker.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createDatabase, migrate, seed } from './test-database';
import worker from '../worker/index';

let runtime = createDatabase();
let db = (await runtime.getD1Database('DB')) as unknown as D1Database;
await migrate(db);
await seed(db);
const root = resolve('dist');
const active = new Set<Promise<Response>>();
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/__test/reset' && req.method === 'POST') {
      await Promise.allSettled([...active]);
      await runtime.dispose();
      runtime = createDatabase();
      db = (await runtime.getD1Database('DB')) as unknown as D1Database;
      await migrate(db);
      await seed(db);
      res.end('Reset');
      return;
    }
    if (req.url?.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const headers = new Headers();
      Object.entries(req.headers).forEach(([key, value]) => {
        if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      });
      const pending = worker.fetch(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          ...(body ? { body } : {}),
        }),
        { DB: db } as Env,
      );
      active.add(pending);
      let response: Response;
      try {
        response = await pending;
      } finally {
        active.delete(pending);
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    const path = resolve(
      root,
      '.' + decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname),
    );
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let data: Buffer,
      file = path;
    try {
      data = await readFile(file);
    } catch {
      file = resolve(root, 'index.html');
      data = await readFile(file);
    }
    res.writeHead(200, {
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end('Test server failed');
  }
});
server.listen(4173, '127.0.0.1', () =>
  console.log('D1 browser-test server ready on http://localhost:4173'),
);
async function stop() {
  server.close();
  await runtime.dispose();
  process.exit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
