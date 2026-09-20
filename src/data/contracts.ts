import { z } from 'zod';
import type {
  CalendarEvent,
  Chore,
  FamilyMember,
  MealPlan,
  ListItem,
  SharedList,
  CalendarSource,
} from '../types';

export const idSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }, 'Use a valid calendar date.');
const title = z.string().trim().min(1).max(120);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z
  .string()
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const recurrence = z
  .object({
    frequency: z.enum(['none', 'daily', 'weekdays', 'weekly', 'monthly']),
    until: dateSchema.optional(),
  })
  .strict();
const memberIds = z
  .array(idSchema)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length);
export const memberSchema: z.ZodType<FamilyMember> = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(30),
    initial: z.string().min(1).max(4),
    color,
    tint: z.string().regex(/^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/),
  })
  .strict();
export const eventSchema: z.ZodType<CalendarEvent> = z
  .object({
    id: idSchema,
    sourceId: idSchema,
    externalId: z.string().max(500).optional(),
    title,
    date: dateSchema,
    endDate: dateSchema.optional(),
    startTime: time.optional(),
    endTime: time.optional(),
    allDay: z.boolean(),
    timeZone,
    memberIds,
    location: z.string().trim().max(160).optional(),
    notes: z.string().max(2000).optional(),
    recurrence,
  })
  .strict()
  .refine(
    (e) =>
      (!e.endDate || e.endDate >= e.date) &&
      (!e.recurrence.until || e.recurrence.until >= e.date) &&
      (e.allDay ||
        (!!e.startTime &&
          !!e.endTime &&
          ((e.endDate && e.endDate > e.date) || e.endTime > e.startTime))),
    'Check the event dates and times.',
  );
export const choreSchema: z.ZodType<Chore> = z
  .object({
    id: idSchema,
    title,
    memberIds,
    dueDate: dateSchema,
    recurrence,
    completedDates: z.array(dateSchema).max(10000),
  })
  .strict()
  .refine(
    (c) => !c.recurrence.until || c.recurrence.until >= c.dueDate,
    'Repeat end must follow the first due date.',
  );
export const mealSchema: z.ZodType<MealPlan> = z
  .object({
    id: idSchema,
    date: dateSchema,
    title,
    emoji: z.string().min(1).max(24),
    recipeId: idSchema.optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();
export const itemSchema: z.ZodType<ListItem> = z
  .object({ id: idSchema, text: title, completed: z.boolean(), recipeId: idSchema.optional() })
  .strict();
export const listSchema: z.ZodType<SharedList> = z
  .object({ id: idSchema, name: title, items: z.array(itemSchema) })
  .strict();
export const sourceSchema: z.ZodType<CalendarSource> = z
  .object({
    id: idSchema,
    name: title,
    provider: z.enum(['local', 'mock', 'icloud', 'google']),
    color,
  })
  .strict();
export const settingsSchema = z
  .object({ name: z.string().trim().min(1).max(60), timeZone })
  .strict();
export const householdSchema = settingsSchema.extend({
  id: idSchema,
  revision: z.number().int().nonnegative(),
});
export const stateSchema = z.object({
  household: householdSchema,
  family: z.array(memberSchema),
  sources: z.array(sourceSchema),
  events: z.array(eventSchema),
  chores: z.array(choreSchema),
  meals: z.array(mealSchema),
  lists: z.array(listSchema),
});
export type HouseholdState = z.infer<typeof stateSchema>;
export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('member.put'), value: memberSchema }).strict(),
  z.object({ type: z.literal('event.put'), value: eventSchema }).strict(),
  z.object({ type: z.literal('chore.put'), value: choreSchema }).strict(),
  z.object({ type: z.literal('meal.put'), value: mealSchema }).strict(),
  z
    .object({
      type: z.literal('list.put'),
      value: z.object({ id: idSchema, name: title }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('item.put'), listId: idSchema, value: itemSchema }).strict(),
  z
    .object({
      type: z.literal('item.complete'),
      listId: idSchema,
      id: idSchema,
      completed: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('chore.complete'),
      id: idSchema,
      date: dateSchema,
      completed: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('delete'),
      entity: z.enum(['member', 'event', 'chore', 'meal', 'list', 'item']),
      id: idSchema,
    })
    .strict(),
  z.object({ type: z.literal('settings.put'), value: settingsSchema }).strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export const mutationSchema = z
  .object({
    id: idSchema,
    revision: z.number().int().nonnegative(),
    operations: z.array(operationSchema).min(1).max(20),
  })
  .strict();
export type Mutation = z.infer<typeof mutationSchema>;

export function applyOperations(state: HouseholdState, operations: Operation[]): HouseholdState {
  const next = structuredClone(state);
  const put = <T extends { id: string }>(items: T[], item: T) => {
    const index = items.findIndex((i) => i.id === item.id);
    // Later optimistic operations must never mutate an earlier request's retry payload.
    const copy = structuredClone(item);
    if (index < 0) items.push(copy);
    else items[index] = copy;
  };
  for (const op of operations) {
    switch (op.type) {
      case 'member.put':
        put(next.family, op.value);
        break;
      case 'event.put':
        put(next.events, op.value);
        break;
      case 'chore.put':
        put(next.chores, {
          ...op.value,
          completedDates: next.chores.find((c) => c.id === op.value.id)?.completedDates ?? [],
        });
        break;
      case 'meal.put':
        put(next.meals, op.value);
        break;
      case 'list.put':
        put(next.lists, {
          ...op.value,
          items: next.lists.find((l) => l.id === op.value.id)?.items ?? [],
        });
        break;
      case 'item.put': {
        const list = next.lists.find((l) => l.id === op.listId);
        if (list) put(list.items, op.value);
        break;
      }
      case 'item.complete': {
        const item = next.lists.find((l) => l.id === op.listId)?.items.find((i) => i.id === op.id);
        if (item) item.completed = op.completed;
        break;
      }
      case 'chore.complete': {
        const chore = next.chores.find((c) => c.id === op.id);
        if (chore)
          chore.completedDates = op.completed
            ? [...new Set([...chore.completedDates, op.date])]
            : chore.completedDates.filter((d) => d !== op.date);
        break;
      }
      case 'settings.put':
        Object.assign(next.household, op.value);
        break;
      case 'delete':
        switch (op.entity) {
          case 'member':
            next.family = next.family.filter((v) => v.id !== op.id);
            break;
          case 'event':
            next.events = next.events.filter((v) => v.id !== op.id);
            break;
          case 'chore':
            next.chores = next.chores.filter((v) => v.id !== op.id);
            break;
          case 'meal':
            next.meals = next.meals.filter((v) => v.id !== op.id);
            break;
          case 'list':
            next.lists = next.lists.filter((v) => v.id !== op.id);
            break;
          case 'item':
            next.lists.forEach((l) => {
              l.items = l.items.filter((i) => i.id !== op.id);
            });
            break;
        }
    }
  }
  return next;
}
