import { ApiError } from '../database';
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export async function encryptionKey(secret?: string, provider = 'google') {
  try {
    if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw new Error();
    const bytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    if (bytes.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    throw new ApiError(
      503,
      'Calendar credential encryption is not configured correctly.',
      `${provider}_configuration`,
    );
  }
}
const aad = (connectionId: string, purpose: string) =>
  new TextEncoder().encode(`${purpose}:v1:home:${connectionId}`);
export async function encryptSecret(
  token: string,
  secret: string | undefined,
  connectionId: string,
  purpose = 'google-refresh',
  provider = 'google',
) {
  const key = await encryptionKey(secret, provider);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(connectionId, purpose) },
    key,
    new TextEncoder().encode(token),
  );
  return { ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv), version: 1 };
}
export async function decryptSecret(
  ciphertext: string,
  iv: string,
  version: number,
  secret: string | undefined,
  connectionId: string,
  purpose = 'google-refresh',
  provider = 'google',
) {
  const key = await encryptionKey(secret, provider);
  try {
    if (version !== 1) throw new Error();
    const nonce = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
    if (nonce.length !== 12) throw new Error();
    const result = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(connectionId, purpose) },
      key,
      Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0)),
    );
    return new TextDecoder().decode(result);
  } catch {
    throw new ApiError(
      503,
      'Stored calendar credentials could not be read. Restore the encryption key or reconnect.',
      `${provider}_credentials`,
    );
  }
}
