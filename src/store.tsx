import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createMockData, family as mockFamily } from './data/mock';
import { dateKey } from './lib/dates';
import { newId } from './lib/id';
import type { CalendarEvent, Chore, FamilyMember, MealPlan, SharedList } from './types';

function useHouseholdState() {
  const [today, setToday] = useState(() => dateKey(new Date()));
  const [seed] = useState(() => createMockData(today));
  const [events, setEvents] = useState<CalendarEvent[]>(seed.events);
  const [chores, setChores] = useState<Chore[]>(seed.chores);
  const [meals, setMeals] = useState<MealPlan[]>(seed.meals);
  const [lists, setLists] = useState<SharedList[]>(seed.lists);
  const [family, setFamily] = useState<FamilyMember[]>(mockFamily);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setToday(dateKey(new Date())), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const toggleChore = (id: string, day: string) =>
    setChores((current) =>
      current.map((chore) =>
        chore.id !== id
          ? chore
          : {
              ...chore,
              completedDates: chore.completedDates.includes(day)
                ? chore.completedDates.filter((d) => d !== day)
                : [...chore.completedDates, day],
            },
      ),
    );
  const toggleItem = (listId: string, itemId: string) =>
    setLists((current) =>
      current.map((list) =>
        list.id !== listId
          ? list
          : {
              ...list,
              items: list.items.map((item) =>
                item.id !== itemId ? item : { ...item, completed: !item.completed },
              ),
            },
      ),
    );
  const removeItem = (listId: string, itemId: string) =>
    setLists((current) =>
      current.map((list) =>
        list.id !== listId
          ? list
          : { ...list, items: list.items.filter((item) => item.id !== itemId) },
      ),
    );
  const addItem = (listId: string, text: string) => {
    if (!text.trim()) return;
    setLists((current) =>
      current.map((list) =>
        list.id !== listId
          ? list
          : {
              ...list,
              items: [...list.items, { id: newId(), text: text.trim(), completed: false }],
            },
      ),
    );
    setNotice('Added to your list');
  };
  return {
    today,
    events,
    setEvents,
    chores,
    setChores,
    meals,
    setMeals,
    lists,
    setLists,
    family,
    setFamily,
    notice,
    setNotice,
    toggleChore,
    toggleItem,
    removeItem,
    addItem,
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
