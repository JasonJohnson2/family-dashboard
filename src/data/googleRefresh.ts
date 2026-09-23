// Independent from household reads/writes: slow Google calls never hold up rendering or saves.
export class GoogleRefreshController {
  private pending?: Promise<void>;
  private nextCheck = 0;
  private snapshot = { syncing: false, message: '' };
  private listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(syncing: boolean, message: string) {
    this.snapshot = { syncing, message };
    this.listeners.forEach((listener) => listener());
  }
  constructor(private onRefreshed: () => Promise<void>) {}

  refresh = (manual = false): Promise<void> => {
    if (this.pending) return this.pending;
    if (!manual && Date.now() < this.nextCheck) return Promise.resolve();
    this.nextCheck = Date.now() + 60_000;
    this.publish(true, '');
    this.pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetch('/api/google/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(manual ? { manual: true } : {}),
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('unavailable');
        const result = await response.json();
        if (result.synced > 0) await this.onRefreshed();
        const message =
          result.outcome === 'busy'
            ? 'A calendar sync is already running.'
            : result.outcome === 'cooldown'
              ? 'Calendars were just checked. Try again in a minute.'
              : result.outcome === 'unavailable' || result.status?.needsAttention
                ? 'Could not sync all calendars. Saved events are still available. Try again later.'
                : result.status?.enabledCalendars === 0
                  ? manual
                    ? 'No Google calendars enabled.'
                    : ''
                  : result.synced > 0
                    ? 'Updated just now'
                    : manual
                      ? 'Calendars are up to date.'
                      : '';
        this.publish(false, message);
      } catch {
        this.publish(
          false,
          'Could not sync calendars. Saved events are still available. Try again later.',
        );
      } finally {
        clearTimeout(timeout);
        this.pending = undefined;
      }
    })();
    return this.pending;
  };
}
