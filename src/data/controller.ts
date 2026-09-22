import { applyOperations, type HouseholdState, type Mutation, type Operation } from './contracts';
import { SaveError, type HouseholdApi } from './api';
import { newId } from '../lib/id';

export interface SyncSnapshot {
  data?: HouseholdState;
  pending: number;
  refreshing: boolean;
  error: string;
  canRetrySave: boolean;
  lastSaved?: number;
}
type Pending = {
  operations: Operation[];
  id: string;
  resolve: () => void;
  reject: (error: Error) => void;
  request?: Mutation;
};

// One ordered write queue per browser. Revisions prevent stale devices overwriting each other.
export class HouseholdController {
  private base?: HouseholdState;
  private snapshot: SyncSnapshot = {
    pending: 0,
    refreshing: false,
    error: '',
    canRetrySave: false,
  };
  private listeners = new Set<() => void>();
  private queue: Pending[] = [];
  private reading?: Promise<void>;
  private running = false;
  private epoch = 0;
  private failed?: Mutation;
  private writeError = false;
  constructor(private api: HouseholdApi) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(extra: Partial<SyncSnapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...extra,
      data:
        this.base &&
        applyOperations(
          this.base,
          this.queue.flatMap((p) => p.operations),
        ),
      pending: this.queue.length,
      canRetrySave: !!this.failed,
    };
    this.listeners.forEach((listener) => listener());
  }
  refresh = (): Promise<void> => {
    if (this.queue.length) return Promise.resolve();
    if (this.reading) return this.reading;
    const epoch = this.epoch;
    this.publish({ refreshing: true });
    this.reading = (async () => {
      try {
        const data = await this.api.load();
        if (epoch === this.epoch && !this.queue.length) {
          this.base = data;
          this.publish({ error: this.writeError ? this.snapshot.error : '' });
        }
      } catch (error) {
        if (epoch === this.epoch)
          this.publish({
            error: error instanceof Error ? error.message : 'Could not load your household.',
          });
      } finally {
        this.reading = undefined;
        this.publish({ refreshing: false });
      }
    })();
    return this.reading;
  };
  // An import can finish while an older household read is still in flight.
  refreshAfterCurrent = async (): Promise<void> => {
    if (this.reading) await this.reading;
    await this.refresh();
  };
  mutate = (operations: Operation[]): Promise<void> => {
    if (!operations.length) return Promise.resolve();
    if (!this.base || this.failed)
      return Promise.reject(
        new SaveError(
          'Resolve the pending save using Retry save or Dismiss before making another change.',
        ),
      );
    return this.enqueue(operations);
  };
  private enqueue(operations: Operation[], request?: Mutation) {
    this.epoch++;
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({
        operations: structuredClone(operations),
        id: request?.id ?? newId(),
        request,
        resolve,
        reject,
      });
    });
    this.publish({ error: '' });
    void this.drain();
    return promise;
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && this.base) {
        const pending = this.queue[0];
        const request = pending.request ?? {
          id: pending.id,
          revision: this.base.household.revision,
          operations: pending.operations,
        };
        try {
          this.base = await this.api.save(request);
          this.queue.shift();
          this.failed = undefined;
          this.writeError = false;
          this.publish({ error: '', lastSaved: Date.now() });
          pending.resolve();
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error('Your change could not be saved.');
          this.failed = error instanceof SaveError && error.retryable ? request : undefined;
          this.writeError = true;
          const cancelled = this.queue.splice(0);
          const message = `${failure.message}${cancelled.length > 1 ? ' Later changes were also reverted; please enter them again.' : ''}`;
          this.publish({ error: message });
          try {
            this.base = await this.api.load();
          } catch {
            /* Keep the last confirmed snapshot and the visible save error. */
          }
          this.publish({ error: message });
          cancelled.forEach((p) => p.reject(new Error(message)));
        }
      }
    } finally {
      this.running = false;
    }
  }
  retry = async () => {
    if (this.failed) {
      const request = this.failed;
      await this.enqueue(request.operations, request);
    } else await this.refresh();
  };
  dismissError = () => {
    this.failed = undefined;
    this.writeError = false;
    this.publish({ error: '' });
  };
}
