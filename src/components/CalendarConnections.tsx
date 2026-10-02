import { useEffect, useState } from 'react';
import { privateFetch } from '../data/access';
import { operatorHeaders, operatorUnlocked } from '../data/operator';
import { useHousehold } from '../store';
import { Modal } from './ui';
import { RewardOperator } from './RewardOperator';
type Calendar = {
  sourceId: string;
  name: string;
  color: string;
  enabled: boolean;
  privacyMode: 'busy' | 'title' | 'full';
  memberId: string | null;
  lastSyncedAt: string | null;
  lastFailure: string | null;
};
type State = {
  configured: boolean;
  connected: boolean;
  account: string | null;
  calendars: Calendar[];
  sync: { requiresReconnect: boolean; needsAttention: boolean };
};
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await privateFetch(`/api/icloud/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...operatorHeaders() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(110_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error || 'iCloud could not be reached. Saved events are still available.',
    );
  return result;
}
export function CalendarConnections({ onClose }: { onClose: () => void }) {
  const { refresh, calendarRefresh } = useHousehold();
  const [state, setState] = useState<State>();
  const [summary, setSummary] = useState<{
    google: { status: { connected: boolean } };
    icloud: { status: { connected: boolean } };
  }>();
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false),
    [editCredentials, setEditCredentials] = useState(false);
  const [, render] = useState(0),
    unlocked = operatorUnlocked();
  const [account, setAccount] = useState('');
  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await privateFetch('/api/calendar/refresh');
      if (!response.ok) throw new Error('Calendar connections could not be loaded.');
      setSummary((await response.json()).providers);
      if (operatorUnlocked()) {
        const result: State = await api('status');
        setState(result);
        setAccount(result.account ?? '');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load calendar connections.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [unlocked]);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      await load();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the calendar connection.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Calendar connections" onClose={busy ? () => {} : onClose}>
      <div className="calendar-connections">
        <p className="form-intro">
          Bring your plans together. Connected calendars are read only; edit their events in the
          original calendar app.
        </p>
        <section className="connection-section">
          <h3>Google Calendar</h3>
          <p>
            {summary?.google.status.connected
              ? 'Connected · Existing calendar settings are preserved.'
              : 'Not connected'}
          </p>
        </section>
        <section className="connection-section">
          <h3>Apple iCloud Calendar</h3>
          <p>{summary?.icloud.status.connected ? 'Connected' : 'Not connected'}</p>
          <RewardOperator
            onChange={() => {
              if (!operatorUnlocked()) {
                setState(undefined);
                setAccount('');
                setConfirm(false);
                setEditCredentials(false);
              }
              render((n) => n + 1);
            }}
          />
          {!unlocked && (
            <p className="muted">
              Unlock with the household operator PIN to connect or change calendars.
            </p>
          )}
          {loading && <p role="status">Loading connections…</p>}
          {unlocked && state && (
            <>
              {!state.configured && (
                <p role="alert" className="form-error">
                  Secure iCloud storage needs to be configured by the household owner before
                  connecting.
                </p>
              )}
              {state.connected && (
                <>
                  <p>{state.account}</p>
                  {state.sync.requiresReconnect && (
                    <p role="alert">
                      iCloud sign-in needs attention. Update your app-specific password below. Saved
                      events and calendar settings are kept.
                    </p>
                  )}
                  {state.sync.needsAttention && !state.sync.requiresReconnect && (
                    <p role="status">
                      Some calendars could not update. Your saved events are still available.
                    </p>
                  )}
                  <div className="form-actions">
                    <button
                      className="outline-button"
                      disabled={busy}
                      onClick={() => setEditCredentials(!editCredentials)}
                    >
                      Update app-specific password
                    </button>
                    <button
                      className="outline-button danger-text"
                      disabled={busy}
                      onClick={() => setConfirm(true)}
                    >
                      Disconnect iCloud Calendar
                    </button>
                  </div>
                </>
              )}
              {(!state.connected || editCredentials || state.sync.requiresReconnect) && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const password = String(new FormData(form).get('appSpecificPassword') ?? '');
                    // Uncontrolled, cleared before awaiting: never retained in component state or browser storage.
                    (form.elements.namedItem('appSpecificPassword') as HTMLInputElement).value = '';
                    void run(async () => {
                      await api('connect', 'POST', { account, appSpecificPassword: password });
                      setEditCredentials(false);
                      setMessage('Connected. Choose which calendars to show below.');
                    });
                  }}
                >
                  <fieldset disabled={busy || !state.configured} className="editor-fields">
                    <label>
                      Apple Account email
                      <input
                        type="email"
                        required
                        maxLength={254}
                        autoComplete="off"
                        value={account}
                        readOnly={state.connected}
                        onChange={(e) => setAccount(e.target.value)}
                      />
                    </label>
                    <label>
                      App-specific password
                      <input
                        name="appSpecificPassword"
                        type="password"
                        required
                        pattern="[a-zA-Z]{4}(-[a-zA-Z]{4}){3}"
                        autoComplete="off"
                        maxLength={19}
                        placeholder="xxxx-xxxx-xxxx-xxxx"
                      />
                    </label>
                    <p>
                      Use an Apple app-specific password, never your normal Apple Account password.
                      Generate one in{' '}
                      <a href="https://account.apple.com/" target="_blank" rel="noreferrer">
                        Apple Account → Sign-In and Security → App-Specific Passwords
                      </a>
                      . Two-factor authentication must be enabled.
                    </p>
                    <button className="primary" type="submit">
                      {busy
                        ? 'Connecting…'
                        : state.connected
                          ? 'Update credential'
                          : 'Connect iCloud Calendar'}
                    </button>
                  </fieldset>
                </form>
              )}
              {state.connected && (
                <>
                  <div className="form-actions">
                    <button
                      className="outline-button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api('calendars');
                          setMessage('Calendar discovery complete. New calendars are disabled.');
                        })
                      }
                    >
                      Discover calendars
                    </button>
                    <button
                      className="outline-button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await calendarRefresh.refresh(true);
                          setMessage(calendarRefresh.getSnapshot().message);
                        })
                      }
                    >
                      Sync calendars
                    </button>
                  </div>
                  <h3>iCloud calendars</h3>
                  {!state.calendars.length && (
                    <p className="muted">
                      No event calendars were found. Check that this Apple Account has calendars
                      stored in iCloud.
                    </p>
                  )}
                  {state.calendars.map((calendar) => (
                    <CalendarSettings
                      key={calendar.sourceId + JSON.stringify(calendar)}
                      calendar={calendar}
                      busy={busy}
                      save={(settings) =>
                        void run(async () => {
                          await api('calendars', 'PATCH', settings);
                          await refresh();
                          if (settings.enabled) await calendarRefresh.refresh(true);
                          setMessage(
                            settings.enabled
                              ? calendarRefresh.getSnapshot().message
                              : 'Calendar hidden from the dashboard.',
                          );
                        })
                      }
                    />
                  ))}
                </>
              )}
            </>
          )}
        </section>
        {error && (
          <div role="alert" className="form-error">
            <p>{error}</p>
            <button className="outline-button" disabled={busy} onClick={() => void load()}>
              Reload connections
            </button>
          </div>
        )}
        {message && <p role="status">{message}</p>}
        {unlocked && confirm && (
          <div className="connection-confirm">
            <h3>Disconnect iCloud Calendar?</h3>
            <p>
              This removes the saved iCloud credential and imported iCloud events from this
              dashboard. Your Apple calendars, local events and Google events are kept.
            </p>
            <div className="form-actions">
              <button className="outline-button" disabled={busy} onClick={() => setConfirm(false)}>
                Keep connected
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api('disconnect', 'POST', {});
                    setConfirm(false);
                    setMessage('iCloud disconnected.');
                  })
                }
              >
                Confirm disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
function CalendarSettings({
  calendar,
  busy,
  save,
}: {
  calendar: Calendar;
  busy: boolean;
  save: (settings: {
    sourceId: string;
    enabled: boolean;
    privacyMode: Calendar['privacyMode'];
    memberId: string | null;
  }) => void;
}) {
  const { family } = useHousehold();
  const [enabled, setEnabled] = useState(calendar.enabled),
    [privacyMode, setPrivacy] = useState(calendar.privacyMode),
    [memberId, setMember] = useState(calendar.memberId ?? '');
  const changed =
    enabled !== calendar.enabled ||
    privacyMode !== calendar.privacyMode ||
    memberId !== (calendar.memberId ?? '');
  return (
    <form
      className="external-calendar-settings"
      onSubmit={(e) => {
        e.preventDefault();
        save({ sourceId: calendar.sourceId, enabled, privacyMode, memberId: memberId || null });
      }}
    >
      <fieldset disabled={busy} className="editor-fields">
        <legend>{calendar.name}</legend>
        <label className="toggle-label">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Show on dashboard
        </label>
        <label>
          Assigned to
          <select value={memberId} onChange={(e) => setMember(e.target.value)}>
            <option value="">Everyone</option>
            {family.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Privacy
          <select
            aria-label="Privacy"
            value={privacyMode}
            onChange={(e) => setPrivacy(e.target.value as Calendar['privacyMode'])}
          >
            <option value="busy">Busy only</option>
            <option value="title">Title and time</option>
            <option value="full">Full details</option>
          </select>
        </label>
        <small>
          {privacyMode === 'busy'
            ? 'Only times and “Busy” are saved.'
            : privacyMode === 'title'
              ? 'Titles and times are saved; notes and locations are omitted.'
              : 'Titles, times, notes and locations are saved.'}
        </small>
        <p className="muted">
          {calendar.lastFailure
            ? 'Could not update. Saved events remain available.'
            : calendar.lastSyncedAt
              ? `Last updated ${new Date(calendar.lastSyncedAt).toLocaleString()}`
              : enabled
                ? 'Waiting for the first sync.'
                : 'Disabled until you choose to show it.'}
        </p>
        <button className="outline-button" disabled={!changed} type="submit">
          Save calendar
        </button>
      </fieldset>
    </form>
  );
}
