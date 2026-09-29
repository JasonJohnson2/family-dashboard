import { privateFetch } from './access';
// Memory only: refresh/close locks this device. No PIN/token in browser storage.
let session: { token: string; expiresAt: number } | undefined;
export const operatorHeaders = (): Record<string, string> =>
  session && session.expiresAt > Date.now() ? { 'X-Reward-Operator': session.token } : {};
export const operatorUnlocked = () => !!operatorHeaders()['X-Reward-Operator'];
export const lockOperator = () => {
  session = undefined;
};
export async function unlockOperator(pin: string) {
  const response = await privateFetch('/api/rewards/operator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not unlock reward management.');
  session = body;
}
