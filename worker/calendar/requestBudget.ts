import { ApiError } from '../database';
declare global {
  interface Env {
    calendarHttpBudget?: { remaining: number };
  }
}
// One invocation budget across providers, redirects and OAuth token exchanges.
// Leave headroom below Workers Free's 50 external subrequests.
export function providerFetch(input: string, init: RequestInit, budget?: { remaining: number }) {
  if (budget && --budget.remaining < 0)
    throw new ApiError(
      502,
      'Calendar refresh reached its request limit. Saved events remain available.',
      'calendar_limit',
    );
  return fetch(input, init);
}
