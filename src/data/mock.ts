import type {
  CalendarEvent,
  CalendarSource,
  Chore,
  FamilyMember,
  MealPlan,
  SharedList,
} from '../types';
import { addDays, daysFrom, weekStart } from '../lib/dates';

export const family: FamilyMember[] = [
  { id: 'jason', name: 'Jason', initial: 'J', color: '#2877c5', tint: '#dceeff' },
  { id: 'kelly', name: 'Kelly', initial: 'K', color: '#278363', tint: '#d8efe2' },
  { id: 'mia', name: 'Mia', initial: 'M', color: '#bf642f', tint: '#ffe4cf' },
  { id: 'liam', name: 'Liam', initial: 'L', color: '#8b5bc4', tint: '#eee0fa' },
];
export const calendarSources: CalendarSource[] = [
  { id: 'household-demo', name: 'Household · demo', provider: 'mock', color: '#2877c5' },
  { id: 'local', name: 'Our Home', provider: 'local', color: '#278363' },
];
export const everyoneColor = '#478a83';
export function createMockData(today: string) {
  const event = (
    id: string,
    title: string,
    date: string,
    startTime: string,
    endTime: string,
    memberIds: string[],
    extra: Partial<CalendarEvent> = {},
  ): CalendarEvent => ({
    id,
    title,
    date,
    startTime,
    endTime,
    memberIds,
    sourceId: 'household-demo',
    allDay: false,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    recurrence: { frequency: 'none' },
    ...extra,
  });
  const events: CalendarEvent[] = [
    event('work', 'Work', today, '08:00', '16:00', ['jason'], {
      recurrence: { frequency: 'daily' },
      location: 'Home office',
    }),
    event('soccer', 'Soccer practice', today, '15:30', '17:00', ['kelly', 'liam'], {
      recurrence: { frequency: 'weekly' },
      location: 'Community field',
      notes: 'Bring a water bottle and cleats.',
    }),
    event('dinner', 'Dinner · Tacos', today, '18:00', '19:00', [], {
      location: 'Around the table',
    }),
    event('free-time', 'A little downtime', today, '19:30', '20:30', ['liam']),
    event('no-school', 'No school', addDays(today, 1), '', '', ['mia', 'liam'], { allDay: true }),
    event('doctor', 'Doctor appointment', addDays(today, 1), '10:00', '11:00', ['jason'], {
      location: 'Family care clinic',
    }),
    event('movie', 'Family movie night', addDays(today, 3), '19:00', '21:00', [], {
      recurrence: { frequency: 'weekly' },
    }),
    event('market', 'Farmers market', addDays(today, 5), '09:00', '11:00', ['kelly', 'mia']),
  ];
  const chores: Chore[] = [
    {
      id: 'trash',
      title: 'Take out the trash',
      memberIds: ['jason'],
      dueDate: today,
      recurrence: { frequency: 'weekly' },
      completedDates: [],
    },
    {
      id: 'dog',
      title: 'Feed the dog',
      memberIds: ['liam'],
      dueDate: today,
      recurrence: { frequency: 'daily' },
      completedDates: [],
    },
    {
      id: 'dishes',
      title: 'Load the dishwasher',
      memberIds: ['mia'],
      dueDate: today,
      recurrence: { frequency: 'daily' },
      completedDates: [],
    },
    {
      id: 'vacuum',
      title: 'Vacuum the living room',
      memberIds: ['jason'],
      dueDate: today,
      recurrence: { frequency: 'weekly' },
      completedDates: [],
    },
    {
      id: 'plants',
      title: 'Water the plants',
      memberIds: [],
      dueDate: today,
      recurrence: { frequency: 'weekly' },
      completedDates: [],
    },
  ];
  const menu = [
    ['Pasta & salad', '🍝'],
    ['Tacos', '🌮'],
    ['Chicken stir-fry', '🥘'],
    ['Homemade pizza', '🍕'],
    ['Burgers', '🍔'],
    ['Grilled chicken & veggies', '🥗'],
    ['Sunday roast', '🍲'],
  ];
  const meals: MealPlan[] = daysFrom(weekStart(today), 14).map((date, i) => ({
    id: `meal-${date}`,
    date,
    title: date === today ? 'Tacos' : menu[i % 7][0],
    emoji: date === today ? '🌮' : menu[i % 7][1],
  }));
  const lists: SharedList[] = [
    {
      id: 'groceries',
      name: 'Groceries',
      items: ['Milk', 'Eggs', 'Bread', 'Chicken', 'Bananas', 'Paper towels', 'Dish soap'].map(
        (text, i) => ({ id: `g${i}`, text, completed: false }),
      ),
    },
    {
      id: 'household',
      name: 'Household',
      items: ['Replace hallway bulb', 'Book chimney cleaning', 'Drop off donations'].map(
        (text, i) => ({ id: `h${i}`, text, completed: false }),
      ),
    },
    {
      id: 'shopping',
      name: 'Shopping',
      items: ['Soccer cleats', 'Birthday wrapping paper'].map((text, i) => ({
        id: `s${i}`,
        text,
        completed: false,
      })),
    },
  ];
  return { events, chores, meals, lists };
}
