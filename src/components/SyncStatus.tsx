import { useHousehold } from '../store';
export function SyncStatus() {
  const { sync, retrySave, dismissError } = useHousehold();
  if (sync.error)
    return (
      <aside className="sync-status" role="alert">
        <p>{sync.error}</p>
        <div>
          <button
            className="soft-button"
            disabled={!!sync.pending || sync.refreshing}
            onClick={() => {
              void retrySave().catch(() => {});
            }}
          >
            {sync.canRetrySave ? 'Retry save' : 'Refresh'}
          </button>
          {sync.data && (
            <button className="outline-button" disabled={!!sync.pending} onClick={dismissError}>
              Dismiss
            </button>
          )}
        </div>
      </aside>
    );
  if (!sync.data)
    return (
      <div className="sync-status" role="status">
        Loading your household…
      </div>
    );
  return null;
}
