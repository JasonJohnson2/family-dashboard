import { privateFetch } from './access';
// Independent from household reads/writes: slow provider calls never hold up rendering or saves.
export class CalendarRefreshController {
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
        const response = await privateFetch('/api/calendar/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(manual ? { manual: true } : {}),
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('unavailable');
        const result = await response.json();
        if (result.synced > 0) await this.onRefreshed();
        const issues =
          result.providers &&
          Object.entries(result.providers)
            .filter(([, p]) => {
              const provider = p as { outcome: string; status: { needsAttention: boolean } };
              return provider.outcome === 'unavailable' || provider.status.needsAttention;
            })
            .map(([name, value]) => {
              const label = name === 'icloud' ? 'iCloud' : 'Google';
              const provider = value as {
                outcome: string;
                diagnostic?: { code: string; message: string; phase?: string; httpStatus?: number };
                status: { lastFailure?: string; requiresReconnect?: boolean };
              };
              if (provider.diagnostic) {
                const d = provider.diagnostic;
                const details = [d.code, d.phase, d.httpStatus && `HTTP ${d.httpStatus}`]
                  .filter(Boolean)
                  .join(' / ');
                return `${label}: ${d.message} (${details}).`;
              }
              if (provider.status.requiresReconnect)
                return `${label} sign-in needs attention. Reconnect ${label} Calendar.`;
              if (provider.status.lastFailure === 'configuration')
                return `${label} credential configuration needs attention.`;
              return provider.outcome === 'unavailable'
                ? `${label} could not sync.`
                : `${label} has a saved sync warning. Check its connection settings.`;
            });
        const message =
          result.outcome === 'busy'
            ? 'A calendar sync is already running.'
            : result.outcome === 'cooldown'
              ? 'Calendars were just checked. Try again in a minute.'
              : result.outcome === 'unavailable' || result.status?.needsAttention
                ? issues?.length
                  ? `${issues.join(' ')} Saved events are still available; other calendars remain usable.`
                  : 'Could not sync all calendars. Saved events are still available. Try again later.'
                : result.status?.enabledCalendars === 0
                  ? manual
                    ? 'No external calendars enabled.'
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
