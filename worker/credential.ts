// Shared only by the Worker and the local bootstrap helper; never imported by React.
export const ITERATIONS = 100_000;
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (value: string) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
export function validCredential(value: string) {
  return value.length >= 20 && value.length <= 128 && value.trim().length >= 20;
}
export function validVerifier(value: string) {
  return /^pbkdf2-sha256\$100000\$[a-f0-9]{64}\$[a-f0-9]{64}$/.test(value);
}
async function derive(value: string, salt: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(value),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: ITERATIONS,
        salt: Uint8Array.from(salt.match(/../g)!, (b) => parseInt(b, 16)),
      },
      key,
      256,
    ),
  );
}
export async function createVerifier(value: string) {
  if (!validCredential(value))
    throw new Error(
      'Use 20–128 characters. Prefer a password-manager-generated password or several random words.',
    );
  const salt = randomToken();
  return `pbkdf2-sha256$${ITERATIONS}$${salt}$${await derive(value, salt)}`;
}
export async function verifyCredential(value: string, verifier: string) {
  if (!validVerifier(verifier)) return false;
  const [, , salt, expected] = verifier.split('$');
  const actual = await derive(value, salt);
  let different = 0;
  for (let i = 0; i < expected.length; i++)
    different |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return different === 0;
}
