export type DateKey = string; // YYYY-MM-DD in the household's local calendar.
export type MemberId = string;
export interface FamilyMember {
  role: 'adult' | 'child';
  id: MemberId;
  name: string;
  initial: string;
  color: string;
  tint: string;
}
export type Recurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
export interface RecurrenceRule {
  frequency: Recurrence;
  until?: DateKey;
}
export interface EventRecurrenceRule {
  frequency: Recurrence | 'yearly';
  interval?: number;
  byWeekday?: number[]; // RFC BYDAY: Sunday=0; weekly rules use Monday WKST.
  monthWeek?: number; // 1..5 or -1 (last), with one byWeekday.
  until?: DateKey; // Inclusive local date.
  count?: number;
}
export interface EventException {
  eventId: string;
  recurrenceDate: DateKey; // Original start date, even when moved.
  cancelled: boolean;
  value?: CalendarEvent; // Full replacement snapshot, never a separate series.
}
export type EventScope = 'this' | 'future' | 'all';
export type LocalEventChange =
  | { type: 'event.put'; value: CalendarEvent }
  | {
      type: 'event.edit';
      id: string;
      recurrenceDate: DateKey;
      scope: EventScope;
      value: CalendarEvent;
      newSeriesId?: string;
    }
  | { type: 'event.delete'; id: string; recurrenceDate: DateKey; scope: EventScope }
  | { type: 'delete'; entity: 'event'; id: string };
export type CalendarPrivacyMode = 'busy' | 'title' | 'full';
export type CalendarProviderKind = 'local' | 'icloud' | 'google' | 'mock';
export interface CalendarSource {
  id: string;
  name: string;
  provider: CalendarProviderKind;
  color: string;
}
export interface CalendarEvent {
  id: string;
  sourceId: string;
  externalId?: string;
  title: string;
  date: DateKey;
  endDate?: DateKey;
  startTime?: string;
  endTime?: string;
  startInstant?: string;
  endInstant?: string;
  allDay: boolean;
  timeZone: string;
  memberIds: MemberId[];
  location?: string;
  notes?: string;
  recurrence: EventRecurrenceRule;
  createdAt?: string;
  updatedAt?: string;
  reminderMinutes?: number; // Configuration only; no notification delivery in V2.
}
export interface EventOccurrence extends CalendarEvent {
  occurrenceDate: DateKey;
  occurrenceId: string;
  recurrenceDate: DateKey;
  isException?: boolean;
}
export interface Chore {
  stars?: number;
  id: string;
  title: string;
  memberIds: MemberId[];
  dueDate: DateKey;
  recurrence: RecurrenceRule;
  completedDates: DateKey[];
}
export interface Recipe {
  id: string;
  title: string;
  ingredients: { name: string; quantity?: string }[];
  instructions: string[];
}
export interface MealPlan {
  id: string;
  date: DateKey;
  title: string;
  emoji: string;
  recipeId?: string;
  notes?: string;
}
export interface ListItem {
  id: string;
  text: string;
  completed: boolean;
  recipeId?: string;
}
export interface SharedList {
  id: string;
  name: string;
  items: ListItem[];
}
export type Section = 'home' | 'calendar' | 'chores' | 'meals' | 'lists' | 'rewards';
