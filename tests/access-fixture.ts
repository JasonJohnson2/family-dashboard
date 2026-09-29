import { expect, type APIRequestContext } from '@playwright/test';
export const testCredential = 'test-only-household-passphrase-493827';
export async function loginHousehold(
  request: APIRequestContext,
  trusted = true,
  name = 'Test browser',
) {
  const response = await request.post('/api/auth/login', {
    data: { credential: testCredential, trusted, name },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
