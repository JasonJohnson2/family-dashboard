export const STALE_MS = 60 * 60_000;
export const RETRY_MS = 60 * 60_000;
export const MANUAL_RETRY_MS = 60_000;
export const PAST_DAYS = 30;
export const FUTURE_DAYS = 365;
export const WINDOW_RENEW_MS = 30 * 86400000;
export const projectionWindow = (now = Date.now()) => ({
  from: new Date(now - PAST_DAYS * 86400000).toISOString(),
  to: new Date(now + FUTURE_DAYS * 86400000).toISOString(),
});
