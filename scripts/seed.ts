import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { seedStatements } from './seed-data';

const args = process.argv.slice(2);
const mode = args.includes('--demo') ? 'demo' : 'starter';
if (args.includes('--remote') && mode === 'demo')
  throw new Error('Demo seeding is local only. Use the starter seed in production.');
mkdirSync('.wrangler', { recursive: true });
const file = `.wrangler/seed-${mode}.sql`;
writeFileSync(file, seedStatements(mode).join(';\n') + ';\n');
if (!args.includes('--generate-only')) {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'DB',
      args.includes('--remote') ? '--remote' : '--local',
      '--file',
      file,
      '--yes',
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
}
