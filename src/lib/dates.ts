import type { CalendarEvent, DateKey, EventOccurrence, RecurrenceRule } from '../types';

export const dateKey = (date: Date): DateKey =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const parseDate = (key: DateKey) => new Date(`${key}T12:00:00`);
export function addDays(key: DateKey, count: number): DateKey {
  const date = parseDate(key);
  date.setDate(date.getDate() + count);
  return dateKey(date);
}
export function weekStart(key: DateKey): DateKey {
  return addDays(key, -parseDate(key).getDay());
}
export function daysFrom(key: DateKey, count: number): DateKey[] {
  return Array.from({ length: count }, (_, i) => addDays(key, i));
}
export function shiftMonth(key: DateKey, count: number): DateKey {
  const date = parseDate(key);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + count);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, last));
  return dateKey(date);
}
export function formatDate(
  key: DateKey,
  options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric' },
): string {
  return parseDate(key).toLocaleDateString('en-US', options);
}
export function formatTime(time?: string): string {
  if (!time) return 'All day';
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
export function occursOn(start: DateKey, target: DateKey, rule: RecurrenceRule): boolean {
  if (target < start || (rule.until && target > rule.until)) return false;
  if (rule.frequency === 'none') return start === target;
  const date = parseDate(target);
  switch (rule.frequency) {
    case 'daily':
      return true;
    case 'weekdays':
      return date.getDay() > 0 && date.getDay() < 6;
    case 'weekly':
      return date.getDay() === parseDate(start).getDay();
    case 'monthly':
      return date.getDate() === parseDate(start).getDate();
  }
}
export function eventsOn(events: CalendarEvent[], day: DateKey): EventOccurrence[] {
  return events
    .filter(
      (event) =>
        occursOn(event.date, day, event.recurrence) ||
        (event.recurrence.frequency === 'none' &&
          event.endDate &&
          event.date <= day &&
          event.endDate >= day),
    )
    .map((event) => ({ ...event, occurrenceDate: day, occurrenceId: `${event.id}:${day}` }))
    .sort((a, b) =>
      (a.allDay ? '' : (a.startTime ?? '')).localeCompare(b.allDay ? '' : (b.startTime ?? '')),
    );
}
