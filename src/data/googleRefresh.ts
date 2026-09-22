// Independent from household reads/writes: slow Google calls never hold up rendering or saves.
export class GoogleRefreshController {
  private pending?: Promise<void>;
  private nextCheck = 0;
  constructor(private onRefreshed: () => Promise<void>) {}

  refresh = (): Promise<void> => {
    if (this.pending) return this.pending;
    if (Date.now() < this.nextCheck) return Promise.resolve();
    this.nextCheck = Date.now() + 60_000;
    this.pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetch('/api/google/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const result = await response.json();
        if (result.synced > 0) await this.onRefreshed();
      } catch {
        // Cached household remains usable. Server status retains a sanitized failure;
        // the normal visible-page timer retries, subject to the durable server cooldown.
      } finally {
        clearTimeout(timeout);
        this.pending = undefined;
      }
    })();
    return this.pending;
  };
}
