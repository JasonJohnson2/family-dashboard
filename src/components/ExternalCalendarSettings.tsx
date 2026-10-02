import { useState } from 'react';
import { useHousehold } from '../store';
export type ExternalCalendar = {
  sourceId: string;
  name: string;
  color: string;
  enabled: boolean;
  privacyMode: 'busy' | 'title' | 'full';
  memberId: string | null;
  lastSyncedAt: string | null;
  lastFailure: string | null;
};
type Calendar = ExternalCalendar;
export function CalendarSettings({
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
