import { stateSchema, type HouseholdState, type Mutation } from './contracts';

export class SaveError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public code = 'network',
  ) {
    super(message);
  }
}
export interface HouseholdApi {
  load(): Promise<HouseholdState>;
  save(mutation: Mutation): Promise<HouseholdState>;
}
async function request(path: string, init?: RequestInit): Promise<HouseholdState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { ...init, cache: 'no-store', signal: controller.signal });
    const body = await response.json();
    if (!response.ok)
      throw new SaveError(body.error || 'Please try again.', response.status >= 500, body.code);
    return stateSchema.parse(body);
  } catch (error) {
    if (error instanceof SaveError) throw error;
    throw new SaveError(
      'Could not reach your household. The last change is not confirmed. Reconnect and retry.',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}
export const householdApi: HouseholdApi = {
  load: () => request('/api/household'),
  save: (mutation) =>
    request('/api/mutations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mutation),
    }),
};
