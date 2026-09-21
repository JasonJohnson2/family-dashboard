import type { CalendarEvent, CalendarSource, DateKey } from '../types';

/** Transport-neutral seam. Google imports are normalized server-side; Apple/CalDAV remains a future provider. */
export interface CalendarProvider {
  readonly source: CalendarSource;
  listEvents(range: { from: DateKey; to: DateKey }): Promise<CalendarEvent[]>;
}

// The prototype loads recurrence masters, then expands them in the view layer.
export function createMockCalendarProvider(
  source: CalendarSource,
  events: CalendarEvent[],
): CalendarProvider {
  return {
    source,
    async listEvents() {
      return structuredClone(events.filter((event) => event.sourceId === source.id));
    },
  };
}
