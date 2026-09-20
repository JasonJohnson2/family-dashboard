import { spawn } from 'node:child_process';
const children = [
  spawn(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'dev', '--ip', '127.0.0.1', '--port', '8787'],
    { stdio: 'inherit', windowsHide: true },
  ),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], {
    stdio: 'inherit',
    windowsHide: true,
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => child.kill());
  process.exitCode = code;
}
children.forEach((child) => {
  child.on('error', () => stop(1));
  child.on('exit', (code) => stop(code ?? 0));
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
