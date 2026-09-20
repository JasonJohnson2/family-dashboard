import { describe, expect, it } from 'vitest';
import { addDays, eventsOn, occursOn, shiftMonth, weekStart } from './dates';
import { createMockData } from '../data/mock';

describe('household dates and recurrence', () => {
  it('crosses year boundaries and starts weeks on Sunday', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekStart('2026-09-20')).toBe('2026-09-20');
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('does not generate occurrences before the start or after the end', () => {
    expect(occursOn('2026-09-19', '2026-09-18', { frequency: 'daily' })).toBe(false);
    expect(occursOn('2026-09-19', '2026-09-21', { frequency: 'daily', until: '2026-09-20' })).toBe(
      false,
    );
  });
  it('handles weekdays, weekly and monthly schedules without shifting month-end dates', () => {
    expect(occursOn('2026-09-18', '2026-09-19', { frequency: 'weekdays' })).toBe(false);
    expect(occursOn('2026-09-18', '2026-09-21', { frequency: 'weekdays' })).toBe(true);
    expect(occursOn('2026-09-19', '2026-09-26', { frequency: 'weekly' })).toBe(true);
    expect(occursOn('2026-01-31', '2026-02-28', { frequency: 'monthly' })).toBe(false);
    expect(occursOn('2026-01-31', '2026-03-31', { frequency: 'monthly' })).toBe(true);
  });
  it('orders all-day events first and gives each recurrence a unique identity', () => {
    const { events } = createMockData('2026-09-19');
    const next = eventsOn(events, '2026-09-20');
    expect(next[0].title).toBe('No school');
    expect(next.find((e) => e.id === 'work')?.occurrenceId).toBe('work:2026-09-20');
    expect(eventsOn(events, '2026-09-26').some((e) => e.id === 'soccer')).toBe(true);
  });
});
