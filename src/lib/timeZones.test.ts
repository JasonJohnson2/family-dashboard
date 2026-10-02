import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());

it('rejects invalid timezone input and evicts old formatters instead of growing indefinitely', async () => {
  vi.resetModules();
  const { timeZoneFormatter, isValidTimeZone } = await import('./timeZones');
  expect(isValidTimeZone('not/a/timezone')).toBe(false);
  const first = timeZoneFormatter('UTC');
  for (const zone of [
    'America/New_York',
    'Europe/London',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Dubai',
    'America/Toronto',
  ])
    expect(isValidTimeZone(zone)).toBe(true);
  expect(timeZoneFormatter('UTC')).not.toBe(first);
  expect(timeZoneFormatter('America/Toronto')).toBe(timeZoneFormatter('America/Toronto'));
  expect(isValidTimeZone('not/a/timezone')).toBe(false);
});
