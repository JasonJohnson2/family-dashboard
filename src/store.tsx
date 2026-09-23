import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { dateKey } from './lib/dates';
import { newId } from './lib/id';
import { householdApi } from './data/api';
import { HouseholdController } from './data/controller';
import { GoogleRefreshController } from './data/googleRefresh';
import type { Operation } from './data/contracts';
import type { CalendarEvent, Chore, FamilyMember, MealPlan, SharedList } from './types';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function useHouseholdState() {
  const [controller] = useState(() => new HouseholdController(householdApi));
  const [googleRefresh] = useState(
    () => new GoogleRefreshController(controller.refreshAfterCurrent),
  );
  const sync = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [today, setToday] = useState(() => dateKey(new Date()));
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void controller.refresh();
      }
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    const clock = setInterval(() => setToday(dateKey(new Date())), 30_000);
    const timer = setInterval(refresh, 60_000);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.getSnapshot().pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearInterval(clock);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [controller]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  function update<T extends { id: string }>(
    current: T[],
    action: SetStateAction<T[]>,
    put: (value: T) => Operation,
    entity: 'member' | 'event' | 'chore' | 'meal',
  ) {
    const next = typeof action === 'function' ? action(current) : action;
    const operations: Operation[] = current
      .filter((v) => !next.some((n) => n.id === v.id))
      .map((v) => ({ type: 'delete', entity, id: v.id }));
    next.forEach((v) => {
      if (
        !equal(
          current.find((c) => c.id === v.id),
          v,
        )
      )
        operations.push(put(v));
    });
    return controller.mutate(operations);
  }
  const data = () => controller.getSnapshot().data!;
  const setFamily = (action: SetStateAction<FamilyMember[]>) =>
    update(data().family, action, (value) => ({ type: 'member.put', value }), 'member');
  const setEvents = (action: SetStateAction<CalendarEvent[]>) =>
    update(data().events, action, (value) => ({ type: 'event.put', value }), 'event');
  const setChores = (action: SetStateAction<Chore[]>) =>
    update(data().chores, action, (value) => ({ type: 'chore.put', value }), 'chore');
  const setMeals = (action: SetStateAction<MealPlan[]>) =>
    update(data().meals, action, (value) => ({ type: 'meal.put', value }), 'meal');
  const setLists = (action: SetStateAction<SharedList[]>) => {
    const current = data().lists,
      next = typeof action === 'function' ? action(current) : action;
    const operations: Operation[] = current
      .filter((l) => !next.some((n) => n.id === l.id))
      .map((l) => ({ type: 'delete', entity: 'list', id: l.id }));
    next.forEach((list) => {
      const before = current.find((l) => l.id === list.id);
      if (!before || before.name !== list.name)
        operations.push({ type: 'list.put', value: { id: list.id, name: list.name } });
      before?.items
        .filter((i) => !list.items.some((n) => n.id === i.id))
        .forEach((i) => operations.push({ type: 'delete', entity: 'item', id: i.id }));
      list.items.forEach((item) => {
        if (
          !equal(
            before?.items.find((i) => i.id === item.id),
            item,
          )
        )
          operations.push({ type: 'item.put', listId: list.id, value: item });
      });
    });
    return controller.mutate(operations);
  };
  const quick = (operations: Operation[]) => {
    void controller.mutate(operations).catch(() => {
      /* The shared sync banner presents save failures. */
    });
  };
  const toggleChore = (id: string, day: string) =>
    quick([
      {
        type: 'chore.complete',
        id,
        date: day,
        completed: !data()
          .chores.find((c) => c.id === id)
          ?.completedDates.includes(day),
      },
    ]);
  const toggleItem = (listId: string, id: string) =>
    quick([
      {
        type: 'item.complete',
        listId,
        id,
        completed: !data()
          .lists.find((l) => l.id === listId)
          ?.items.find((i) => i.id === id)?.completed,
      },
    ]);
  const removeItem = (_listId: string, id: string) =>
    quick([{ type: 'delete', entity: 'item', id }]);
  const addItem = async (listId: string, text: string, id = newId()) => {
    if (!text.trim()) return;
    await controller.mutate([
      { type: 'item.put', listId, value: { id, text: text.trim(), completed: false } },
    ]);
    setNotice('Added to your list');
  };
  return {
    today,
    googleRefresh,
    family: sync.data?.family ?? [],
    events: sync.data?.events ?? [],
    chores: sync.data?.chores ?? [],
    meals: sync.data?.meals ?? [],
    lists: sync.data?.lists ?? [],
    sources: sync.data?.sources ?? [],
    household: sync.data?.household,
    setFamily,
    setEvents,
    setChores,
    setMeals,
    setLists,
    toggleChore,
    toggleItem,
    removeItem,
    addItem,
    notice,
    setNotice,
    sync,
    refresh: controller.refresh,
    retrySave: controller.retry,
    dismissError: controller.dismissError,
  };
}
const HouseholdContext = createContext<ReturnType<typeof useHouseholdState> | null>(null);
export function HouseholdProvider({ children }: { children: ReactNode }) {
  return (
    <HouseholdContext.Provider value={useHouseholdState()}>{children}</HouseholdContext.Provider>
  );
}
export function useHousehold() {
  const value = useContext(HouseholdContext);
  if (!value) throw new Error('HouseholdProvider is required');
  return value;
}
