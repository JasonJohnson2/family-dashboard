import { useHousehold } from '../store';
import { useRegisterSW } from 'virtual:pwa-register/react';

export function AppUpdate() {
  const { sync } = useHousehold();
  const {
    needRefresh: [ready, setReady],
    updateServiceWorker,
  } = useRegisterSW();
  if (!ready) return null;
  return (
    <aside className="update-prompt" aria-label="App update available">
      <p>A fresh version is ready.</p>
      <small>Saved household data stays safe. Finish unsaved forms before updating.</small>
      <div>
        <button className="outline-button" onClick={() => setReady(false)}>
          Later
        </button>
        <button
          className="primary"
          disabled={!!sync.pending}
          onClick={() => updateServiceWorker(true)}
        >
          Update app
        </button>
      </div>
    </aside>
  );
}
