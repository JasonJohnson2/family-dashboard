import { ApiError } from '../database';

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
export async function encryptionKey(secret?: string) {
  try {
    if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw new Error();
    const bytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    if (bytes.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    throw new ApiError(
      503,
      'Google token encryption is not configured correctly.',
      'google_configuration',
    );
  }
}
const aad = (connectionId: string) =>
  new TextEncoder().encode(`google-refresh:v1:home:${connectionId}`);
export async function encryptToken(
  token: string,
  secret: string | undefined,
  connectionId: string,
) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(connectionId) },
    key,
    new TextEncoder().encode(token),
  );
  return { ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv), version: 1 };
}
export async function decryptToken(
  ciphertext: string,
  iv: string,
  version: number,
  secret: string | undefined,
  connectionId: string,
) {
  const key = await encryptionKey(secret);
  try {
    if (version !== 1) throw new Error();
    const nonce = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
    if (nonce.length !== 12) throw new Error();
    const result = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(connectionId) },
      key,
      Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0)),
    );
    return new TextDecoder().decode(result);
  } catch {
    throw new ApiError(
      503,
      'Stored Google credentials could not be read. Restore the encryption key or reconnect.',
      'google_credentials',
    );
  }
}
