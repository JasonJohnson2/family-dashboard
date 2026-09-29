import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createVerifier } from '../worker/credential';

if (!process.stdin.isTTY)
  throw new Error(
    'Run this helper in an interactive terminal. Do not pass credentials as arguments or pipe them.',
  );
// readline still handles editing/paste, but its output cannot echo the credential.
const silent = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const input = createInterface({ input: process.stdin, output: silent, terminal: true });
input.on('SIGINT', () => {
  input.close();
  process.exit(1);
});
const ask = (prompt: string) =>
  new Promise<string>((resolve) => {
    process.stdout.write(prompt);
    input.question('', (value) => {
      process.stdout.write('\n');
      resolve(value);
    });
  });
try {
  console.log(
    'Save a strong 20–128 character credential in your password manager first. Input is hidden.',
  );
  const credential = await ask('Household credential: ');
  const confirmation = await ask('Confirm credential: ');
  if (credential !== confirmation)
    throw new Error('Credentials did not match. Run the helper again.');
  const verifier = await createVerifier(credential);
  console.log(
    '\nCopy the following verifier into the Cloudflare Worker secret HOUSEHOLD_BOOTSTRAP_VERIFIER. It is a salted hash, not your credential. Treat it as sensitive.\n',
  );
  console.log(verifier);
  console.log('\nNo files were written and no network requests were made.');
} finally {
  input.close();
}
