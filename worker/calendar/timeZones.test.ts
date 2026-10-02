import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());

it('constructs one formatter for a large timed import, including repeated event-schema validation', async () => {
  vi.resetModules();
  const NativeFormatter = Intl.DateTimeFormat;
  const constructor = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args) {
    return new NativeFormatter(...args);
  });
  const { normalizeEvent, localTime } = await import('../google/normalize');
  const calendar = { source_id: 'fixture', privacy_mode: 'title', member_id: null } as Parameters<
    typeof normalizeEvent
  >[1];
  for (let i = 0; i < 250; i++) {
    const event = await normalizeEvent(
      {
        id: String(i),
        summary: 'Fixture',
        start: { dateTime: '2026-10-02T13:00:00Z' },
        end: { dateTime: '2026-10-02T14:00:00Z' },
      },
      calendar,
      'America/New_York',
    );
    expect(event).toMatchObject({ date: '2026-10-02', startTime: '09:00', endTime: '10:00' });
  }
  expect(constructor).toHaveBeenCalledTimes(1);
  expect(localTime('2026-11-01T05:30:00Z', 'America/New_York')).toEqual({
    date: '2026-11-01',
    time: '01:30',
  });
  expect(localTime('2026-11-01T06:30:00Z', 'America/New_York')).toEqual({
    date: '2026-11-01',
    time: '01:30',
  });
  expect(localTime('2026-10-02T13:00:00Z', 'Europe/London')).toEqual({
    date: '2026-10-02',
    time: '14:00',
  });
  expect(constructor).toHaveBeenCalledTimes(2);
});
