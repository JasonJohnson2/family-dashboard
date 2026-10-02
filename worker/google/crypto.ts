const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export const randomToken = () =>
  encode(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export {
  encryptionKey,
  encryptSecret as encryptToken,
  decryptSecret as decryptToken,
} from '../calendar/credentials';
