export type DateKey = string; // YYYY-MM-DD in the household's local calendar.
export type MemberId = string;
export interface FamilyMember {
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
  allDay: boolean;
  timeZone: string;
  memberIds: MemberId[];
  location?: string;
  notes?: string;
  recurrence: RecurrenceRule;
}
export interface EventOccurrence extends CalendarEvent {
  occurrenceDate: DateKey;
  occurrenceId: string;
}
export interface Chore {
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
export type Section = 'home' | 'calendar' | 'chores' | 'meals' | 'lists';
