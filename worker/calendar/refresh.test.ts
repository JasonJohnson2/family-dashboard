import { afterEach, expect, it, vi } from 'vitest';
import { automaticSync } from '../google/automatic';
import { syncStatus } from '../google/status';
import { sync, status } from '../icloud/service';
import { refreshCalendars } from './refresh';
import { withTestCalendarExecutor } from '../../scripts/test-calendar-executor';

vi.mock('../google/automatic', () => ({ automaticSync: vi.fn() }));
vi.mock('../google/status', () => ({ syncStatus: vi.fn() }));
vi.mock('../icloud/service', () => ({ sync: vi.fn(), status: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const request = () =>
  new Request('https://dashboard.test/api/calendar/refresh', {
    method: 'POST',
    headers: { Origin: 'https://dashboard.test', 'Content-Type': 'application/json' },
    body: '{"manual":true}',
  });
const env = { DB: {} } as Env;
const healthy = { enabledCalendars: 1, needsAttention: false };

it.each(['google', 'icloud'] as const)(
  'retains committed sync results when %s status cannot be loaded',
  async (provider) => {
    vi.mocked(automaticSync).mockResolvedValue({ outcome: 'complete', synced: 1 });
    vi.mocked(sync).mockResolvedValue({ outcome: 'complete', synced: 1 });
    vi.mocked(syncStatus).mockResolvedValue(healthy as Awaited<ReturnType<typeof syncStatus>>);
    vi.mocked(status).mockResolvedValue(healthy as Awaited<ReturnType<typeof status>>);
    const failure = provider === 'google' ? vi.mocked(syncStatus) : vi.mocked(status);
    failure.mockRejectedValue(new Error('D1 private SQL account token'));
    const response = await refreshCalendars(request(), withTestCalendarExecutor(env));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: 'unavailable',
      synced: 2,
      status: { needsAttention: true },
    });
    expect(body.providers[provider]).toMatchObject({
      diagnostic: { code: 'calendar_status', phase: 'database' },
    });
    expect(body.providers[provider === 'google' ? 'icloud' : 'google']).toEqual({
      outcome: 'complete',
      synced: 1,
      status: healthy,
    });
    expect(JSON.stringify(body)).not.toContain('private SQL');
    expect(automaticSync).toHaveBeenCalledWith(
      expect.objectContaining({ DB: env.DB, calendarHttpBudget: { remaining: 40 } }),
      true,
    );
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ DB: env.DB, calendarHttpBudget: { remaining: 40 } }),
      true,
    );
  },
);

it('keeps GET status reads free of synchronization and reports database failure safely', async () => {
  vi.mocked(syncStatus).mockRejectedValue(new Error('private database detail'));
  vi.mocked(status).mockRejectedValue(new Error('private database detail'));
  const body = await (
    await refreshCalendars(new Request('https://dashboard.test/api/calendar/refresh'), env)
  ).json();
  expect(body).toMatchObject({
    outcome: 'unavailable',
    synced: 0,
    status: { needsAttention: true },
  });
  expect(automaticSync).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  expect(JSON.stringify(body)).not.toContain('private database detail');
});
