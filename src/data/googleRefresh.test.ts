import { afterEach, expect, it, vi } from 'vitest';
import { GoogleRefreshController } from './googleRefresh';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('deduplicates active checks and reloads household data after a successful Google import', async () => {
  vi.useFakeTimers();
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const reload = vi.fn(async () => {});
  const refresh = new GoogleRefreshController(reload);
  const pending = refresh.refresh();
  expect(refresh.refresh()).toBe(pending);
  expect(reload).not.toHaveBeenCalled();
  const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
  expect(url).toBe('/api/google/refresh');
  expect(init?.body).toBe('{}');
  expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
  resolve(Response.json({ synced: 1 }));
  await pending;
  expect(reload).toHaveBeenCalledTimes(1);
  await refresh.refresh();
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  const next = refresh.refresh();
  resolve(Response.json({ synced: 0, outcome: 'busy' }));
  await next;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('isolates network, HTTP and timeout failures from household loading and allows later retries', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockImplementationOnce(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    )
    .mockResolvedValue(Response.json({ synced: 1 }));
  vi.stubGlobal('fetch', fetch);
  const reload = vi.fn(async () => {});
  const refresh = new GoogleRefreshController(reload);
  await refresh.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  await refresh.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  const pending = refresh.refresh();
  await vi.advanceTimersByTimeAsync(120_000);
  await pending;
  expect(reload).not.toHaveBeenCalled();
  await refresh.refresh();
  expect(reload).toHaveBeenCalledTimes(1);
});
