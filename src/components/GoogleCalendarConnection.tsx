import { useEffect, useRef, useState } from 'react';
import { privateFetch } from '../data/access';
import { operatorHeaders } from '../data/operator';
import { useHousehold } from '../store';
import { CalendarSettings, type ExternalCalendar } from './ExternalCalendarSettings';

type Health = {
  connected: boolean;
  syncing?: boolean;
  needsAttention?: boolean;
  requiresReconnect?: boolean;
  lastFailure?: string | null;
  lastSyncedAt?: string | null;
  enabledCalendars?: number;
};
type State = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  calendars: ExternalCalendar[];
  sync: Health;
};
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await privateFetch(`/api/google/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...operatorHeaders() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(110_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || 'Google Calendar could not be reached. Saved events are kept.');
  return result;
}
const callbackErrors: Record<string, string> = {
  google_denied: 'Google access was not granted. Your existing calendars are unchanged.',
  google_state: 'This connection request expired or could not be verified. Unlock and start again.',
  google_code: 'Google did not finish sign-in. Start again.',
  google_refresh_missing:
    'Google did not grant offline access. Try connecting again and grant both calendar permissions.',
  google_scopes: 'Grant both read-only calendar permissions when connecting.',
  google_configuration: 'Google setup needs attention from the household owner.',
  google_account_mismatch:
    'Choose the Google account already connected to this household. Existing settings and events are unchanged.',
  google_account_unknown:
    'The original account could not be verified. Existing settings and events are unchanged; contact the household owner.',
  google_connected: 'The connection changed during sign-in. Reload connections and start again.',
};
export function googleHealth(health?: Health) {
  if (!health?.connected) return 'Not connected';
  if (health.syncing) return 'Syncing';
  if (health.requiresReconnect) return 'Sign-in required';
  if (health.lastFailure === 'configuration') return 'Configuration needs attention';
  if (health.lastFailure === 'unavailable') return 'Temporarily unavailable';
  if (health.needsAttention) return 'Needs attention';
  return 'Connected';
}
export function GoogleCalendarConnection({
  unlocked,
  summary,
  blocked,
  onBusy,
}: {
  unlocked: boolean;
  summary?: Health;
  blocked: boolean;
  onBusy: (value: boolean) => void;
}) {
  const { refresh } = useHousehold();
  const generation = useRef(0);
  const active = useRef(unlocked);
  active.current = unlocked;
  const [state, setState] = useState<State>();
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState(() => {
    const params = new URLSearchParams(location.hash.split('?')[1]);
    const failure = params.get('google_error');
    if (failure)
      return (
        callbackErrors[failure] ??
        'Google could not finish connecting. Saved events are unchanged. Please try again.'
      );
    return params.get('google') === 'reconnected'
      ? 'Google reconnected. Your calendar settings and saved events were preserved. Unlock controls to sync now.'
      : params.get('google') === 'connected'
        ? 'Google connected. Unlock controls, discover calendars and choose which to show.'
        : '';
  });
  useEffect(() => {
    if (location.hash.startsWith('#connections?')) history.replaceState(null, '', '#connections');
  }, []);
  async function load() {
    const current = generation.current;
    setLoading(true);
    try {
      const result = await api('status');
      if (active.current && current === generation.current) setState(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load Google Calendar.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    generation.current++;
    if (unlocked) void load();
    else {
      setState(undefined);
      setConfirm(false);
      setLoading(false);
    }
    return () => {
      generation.current++;
    };
  }, [unlocked]);
  function working(value: boolean) {
    setBusy(value);
    onBusy(value);
  }
  async function run(action: () => Promise<void>) {
    if (busy || blocked || !unlocked) return;
    working(true);
    setError('');
    setMessage('');
    try {
      await action();
      await load();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google Calendar could not be updated.');
    } finally {
      working(false);
    }
  }
  async function oauth(reconnect: boolean) {
    if (busy || blocked || !unlocked) return;
    working(true);
    setError('');
    setMessage('');
    try {
      const result = await api(reconnect ? 'reconnect' : 'connect');
      const destination = new URL(result.authorizationUrl);
      if (destination.origin !== 'https://accounts.google.com')
        throw new Error('Google returned an unexpected sign-in address.');
      working(false);
      location.assign(destination.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google sign-in could not start.');
      working(false);
    }
  }
  const health = state?.sync ?? summary;
  const disabled = busy || blocked || loading;
  async function syncNow() {
    const result = await api('refresh', 'POST', { manual: true });
    setMessage(
      result.outcome === 'cooldown'
        ? 'Google calendars were just checked. Try again in a minute.'
        : result.outcome === 'busy'
          ? 'Google sync is already running.'
          : result.status.requiresReconnect
            ? 'Google needs permission again. Reconnect below; your saved events and settings are kept.'
            : result.status.lastFailure === 'configuration'
              ? 'Google setup needs attention from the household owner.'
              : result.outcome === 'unavailable' || result.status.needsAttention
                ? 'Google could not update. Saved events are kept. Retry later; reconnect is not required for a temporary error.'
                : result.status.enabledCalendars === 0
                  ? 'No Google calendars are enabled. Choose calendars below.'
                  : 'Google Calendar updated.',
    );
  }
  return (
    <section className="connection-section" aria-label="Google Calendar connection">
      <h3>Google Calendar</h3>
      <p role="status">{googleHealth(health)}</p>
      {message && <p role="status">{message}</p>}
      {!unlocked && <p className="muted">Unlock operator controls to manage Google Calendar.</p>}
      {loading && <p role="status">Loading Google connection…</p>}
      {unlocked && state && (
        <>
          {!state.configured && (
            <p className="form-error" role="alert">
              Google OAuth or secure token storage is incomplete. The household owner must configure
              the documented Worker secrets.
            </p>
          )}
          {state.email && <p>Connected as: {state.email}</p>}
          {health?.lastSyncedAt && (
            <p className="muted">Last synced: {new Date(health.lastSyncedAt).toLocaleString()}</p>
          )}
          {!state.connected && (
            <>
              <p>Keep your Google events visible on the family dashboard.</p>
              <button
                className="primary"
                disabled={disabled || !state.configured}
                onClick={() => void oauth(false)}
              >
                Connect Google Calendar
              </button>
            </>
          )}
          {state.connected && (
            <>
              {health?.requiresReconnect && (
                <>
                  <p>
                    Google needs permission to access your calendars again. Your existing calendar
                    settings and saved events will be preserved. Choose the same Google account.
                  </p>
                  <button
                    className="primary"
                    disabled={disabled || !state.configured}
                    onClick={() => void oauth(true)}
                  >
                    Reconnect Google Calendar
                  </button>
                </>
              )}
              {health?.needsAttention && !health.requiresReconnect && (
                <p>
                  Saved events are still available. Use Sync Now to check the connection; a
                  temporary failure does not require reconnecting.
                </p>
              )}
              <div className="form-actions">
                <button
                  className="outline-button"
                  disabled={disabled || !state.configured || health?.requiresReconnect}
                  onClick={() =>
                    void run(async () => {
                      await api('calendars');
                      setMessage('Calendars discovered. New calendars start disabled.');
                    })
                  }
                >
                  Discover Google calendars
                </button>
                <button
                  className="outline-button"
                  disabled={disabled || !state.configured || health?.requiresReconnect}
                  onClick={() => void run(syncNow)}
                >
                  Sync Now
                </button>
                <button
                  className="outline-button danger-text"
                  disabled={disabled}
                  onClick={() => setConfirm(true)}
                >
                  Disconnect Google Calendar
                </button>
              </div>
              <h3>Google calendars</h3>
              {!state.calendars.length && (
                <p>No calendars selected yet. Discover calendars to get started.</p>
              )}
              {state.calendars.map((calendar) => (
                <CalendarSettings
                  key={calendar.sourceId + JSON.stringify(calendar)}
                  calendar={calendar}
                  busy={disabled}
                  save={(settings) =>
                    void run(async () => {
                      await api('calendars', 'PATCH', settings);
                      setMessage(
                        'Calendar settings saved. Use Sync Now to update enabled calendars.',
                      );
                    })
                  }
                />
              ))}
            </>
          )}
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          <p>{error}</p>
          <button
            className="outline-button"
            disabled={disabled || !unlocked}
            onClick={() => {
              setError('');
              void load();
            }}
          >
            Reload Google connection
          </button>
        </div>
      )}
      {unlocked && confirm && (
        <div className="connection-confirm">
          <h3>Disconnect Google Calendar?</h3>
          <p>
            Google events imported into the Family Dashboard will be removed. Your Google Calendar
            itself will not be changed. Local and iCloud calendars are kept.
          </p>
          <div className="form-actions">
            <button
              className="outline-button"
              disabled={disabled}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await api('disconnect', 'POST', {});
                  setConfirm(false);
                  setMessage('Google Calendar disconnected.');
                })
              }
            >
              Confirm Google disconnect
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
