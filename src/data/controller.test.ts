import { describe, expect, it, vi } from 'vitest';
import { HouseholdController } from './controller';
import { SaveError, type HouseholdApi } from './api';
import { applyOperations, type HouseholdState, type Mutation } from './contracts';

const initial = (): HouseholdState => ({
  household: { id: 'home', name: 'Home', timeZone: 'UTC', revision: 0 },
  family: [],
  sources: [],
  events: [],
  chores: [],
  meals: [],
  lists: [{ id: 'l', name: 'Shopping', items: [{ id: 'i', text: 'Milk', completed: false }] }],
});
const check = (completed: boolean) => ({
  type: 'item.complete' as const,
  listId: 'l',
  id: 'i',
  completed,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
describe('API-backed optimistic store', () => {
  it('checks immediately, serializes rapid changes, and reconciles server revisions', async () => {
    let state = initial();
    const first = deferred<HouseholdState>();
    const api: HouseholdApi = {
      load: async () => state,
      save: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementation(async (m: Mutation) => {
          expect(m.revision).toBe(1);
          state = applyOperations(state, m.operations);
          state.household.revision++;
          return state;
        }),
    };
    const store = new HouseholdController(api);
    await store.refresh();
    const one = store.mutate([check(true)]);
    expect(store.getSnapshot().data?.lists[0].items[0].completed).toBe(true);
    const two = store.mutate([check(false)]);
    expect(store.getSnapshot().data?.lists[0].items[0].completed).toBe(false);
    expect(api.save).toHaveBeenCalledTimes(1);
    state = applyOperations(state, [check(true)]);
    state.household.revision = 1;
    first.resolve(state);
    await Promise.all([one, two]);
    expect(store.getSnapshot().pending).toBe(0);
    expect(store.getSnapshot().data?.household.revision).toBe(2);
  });
  it('reverts failed optimistic changes, retains an error and retries the exact request', async () => {
    const state = initial();
    const saved = applyOperations(state, [check(true)]);
    saved.household.revision = 1;
    const api: HouseholdApi = {
      load: vi.fn().mockResolvedValue(state),
      save: vi
        .fn()
        .mockRejectedValueOnce(new SaveError('Connection lost', true))
        .mockResolvedValue(saved),
    };
    const store = new HouseholdController(api);
    await store.refresh();
    await expect(store.mutate([check(true)])).rejects.toThrow('Connection lost');
    expect(store.getSnapshot().data?.lists[0].items[0].completed).toBe(false);
    expect(store.getSnapshot().error).toBe('Connection lost');
    expect(store.getSnapshot().canRetrySave).toBe(true);
    await store.retry();
    expect(vi.mocked(api.save).mock.calls[0]).toEqual(vi.mocked(api.save).mock.calls[1]);
    expect(store.getSnapshot().error).toBe('');
    expect(store.getSnapshot().data?.lists[0].items[0].completed).toBe(true);
  });
  it('loads the other device state on conflicts without replaying a stale change', async () => {
    let state = initial();
    const api: HouseholdApi = {
      load: async () => state,
      save: async () => {
        state = structuredClone(state);
        state.household.revision = 2;
        state.lists[0].items[0].text = 'Bread';
        throw new SaveError('Changed on another device', false, 'conflict');
      },
    };
    const store = new HouseholdController(api);
    await store.refresh();
    await expect(store.mutate([check(true)])).rejects.toThrow('another device');
    expect(store.getSnapshot().canRetrySave).toBe(false);
    expect(store.getSnapshot().data?.lists[0].items[0]).toMatchObject({
      text: 'Bread',
      completed: false,
    });
  });
  it('does not let a slow refetch overwrite a newer save', async () => {
    const read = deferred<HouseholdState>();
    const state = initial();
    const saved = applyOperations(state, [check(true)]);
    saved.household.revision = 1;
    const api: HouseholdApi = {
      load: vi
        .fn()
        .mockResolvedValueOnce(state)
        .mockImplementation(() => read.promise),
      save: async () => saved,
    };
    const store = new HouseholdController(api);
    await store.refresh();
    const refresh = store.refresh();
    await store.mutate([check(true)]);
    read.resolve(state);
    await refresh;
    expect(store.getSnapshot().data?.household.revision).toBe(1);
  });
  it('reports all cancelled queued changes instead of silently dropping them', async () => {
    const save = deferred<HouseholdState>();
    const store = new HouseholdController({
      load: async () => initial(),
      save: () => save.promise,
    });
    await store.refresh();
    const outcomes = Promise.allSettled([
      store.mutate([check(true)]),
      store.mutate([check(false)]),
    ]);
    save.reject(new SaveError('Failed', true));
    expect((await outcomes).every((r) => r.status === 'rejected')).toBe(true);
    expect(store.getSnapshot().error).toContain('Later changes were also reverted');
    expect(store.getSnapshot().pending).toBe(0);
  });
});

it('optimistic operations do not alter the original retry payload', () => {
  const operations: import('./contracts').Operation[] = [
    { type: 'item.put', listId: 'l', value: { id: 'new', text: 'Bread', completed: false } },
    { type: 'item.complete', listId: 'l', id: 'new', completed: true },
  ];
  const before = structuredClone(operations);
  expect(applyOperations(initial(), operations).lists[0].items[1].completed).toBe(true);
  expect(operations).toEqual(before);
});

it('keeps a rejected-save message visible through automatic refetches', async () => {
  const store = new HouseholdController({
    load: async () => initial(),
    save: async () => {
      throw new SaveError('Please review the conflicting change', false, 'conflict');
    },
  });
  await store.refresh();
  await expect(store.mutate([check(true)])).rejects.toThrow('conflicting');
  await store.refresh();
  expect(store.getSnapshot().error).toContain('conflicting');
  store.dismissError();
  expect(store.getSnapshot().error).toBe('');
});
