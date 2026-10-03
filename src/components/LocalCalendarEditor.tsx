import { useState, useRef, type FormEvent } from 'react';
import { CalendarDays, MapPin, Repeat2, Pencil, Trash2 } from 'lucide-react';
import { useHousehold } from '../store';
import { Avatar, Modal } from './ui';
import { eventSchema } from '../data/contracts';
import { newId } from '../lib/id';
import { formatDate, formatTime } from '../lib/dates';
import { occurrence, recurrenceLabel } from '../lib/localCalendar';
import { weekday } from '../lib/calendarDates';
import type { CalendarEvent, EventOccurrence, EventScope, EventRecurrenceRule } from '../types';

const scopes: [EventScope, string][] = [
  ['this', 'This event'],
  ['future', 'This and future events'],
  ['all', 'All events'],
];
const fingerprint = (value: unknown) => JSON.stringify(value);
function ScopePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: EventScope;
  disabled?: boolean;
  onChange: (s: EventScope) => void;
}) {
  return (
    <fieldset className="event-scope" disabled={disabled}>
      <legend>Apply to</legend>
      {scopes.map(([id, label]) => (
        <label key={id} className="simple-checkbox">
          <input
            type="radio"
            name="event-scope"
            checked={value === id}
            onChange={() => onChange(id)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
function preset(r: EventRecurrenceRule) {
  if (
    r.byWeekday ||
    r.monthWeek ||
    ((r.interval ?? 1) !== 1 && !(r.frequency === 'weekly' && r.interval === 2))
  )
    return 'custom';
  return r.frequency === 'weekly' && r.interval === 2 ? 'biweekly' : r.frequency;
}
export function LocalEventEditor({
  eventId,
  date,
  event,
  scope = 'all',
  onClose,
}: {
  eventId?: string;
  date?: string;
  event?: EventOccurrence;
  scope?: EventScope;
  onClose: () => void;
}) {
  const store = useHousehold();
  const ownAttempt = useRef(false);
  const [master] = useState(() => store.events.find((e) => e.id === eventId));
  const [originalExceptions] = useState(() =>
    store.eventExceptions.filter((e) => e.eventId === eventId),
  );
  const initial =
    master && (scope === 'all' ? master : (event ?? occurrence(master, date ?? master.date)));
  const [id] = useState(() => eventId ?? newId()),
    [futureId] = useState(newId);
  const [draft, setDraft] = useState<CalendarEvent>(() => ({
    ...initial,
    id,
    sourceId: 'local',
    title: initial?.title ?? '',
    date: initial?.date ?? date ?? store.today,
    allDay: initial?.allDay ?? false,
    startTime: initial?.startTime ?? '09:00',
    endTime: initial?.endTime ?? '10:00',
    timeZone: initial?.timeZone ?? store.household!.timeZone,
    memberIds: initial?.memberIds ?? [],
    recurrence: master?.recurrence ?? { frequency: 'none' },
    // Occurrence metadata and generated provider instants are never mutation fields.
  }));
  const [repeat, setRepeat] = useState(() => preset(draft.recurrence));
  const [ends, setEnds] = useState(
    draft.recurrence.count ? 'count' : draft.recurrence.until ? 'date' : 'never',
  );
  const [multi, setMulti] = useState(!!draft.endDate && draft.endDate !== draft.date);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const change = (value: Partial<CalendarEvent>) => setDraft((d) => ({ ...d, ...value }));
  const rule = (value: Partial<EventRecurrenceRule>) =>
    setDraft((d) => ({ ...d, recurrence: { ...d.recurrence, ...value } }));
  const single = !!master && master.recurrence.frequency !== 'none' && scope === 'this';
  function chooseRepeat(value: string) {
    setRepeat(value);
    if (value === 'custom')
      rule({
        frequency:
          draft.recurrence.frequency === 'none' || draft.recurrence.frequency === 'weekdays'
            ? 'weekly'
            : draft.recurrence.frequency,
        interval: draft.recurrence.interval ?? 1,
      });
    else
      change({
        recurrence: {
          frequency: (value === 'biweekly' ? 'weekly' : value) as EventRecurrenceRule['frequency'],
          interval: value === 'biweekly' ? 2 : undefined,
        },
      });
    setEnds('never');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    let attemptedSave = false;
    try {
      if (store.sync.canRetrySave) {
        attemptedSave = true;
        await store.retrySave();
        if (ownAttempt.current) {
          store.setNotice('Calendar change recovered');
          onClose();
        } else setError('Previous household save recovered. Review this form and save your event.');
        return;
      }
      if (
        master &&
        (fingerprint(store.events.find((e) => e.id === master.id)) !== fingerprint(master) ||
          fingerprint(store.eventExceptions.filter((e) => e.eventId === master.id)) !==
            fingerprint(originalExceptions))
      )
        throw new Error(
          'This event changed while you were editing. Close and reopen it to review the latest version.',
        );
      if (eventId && (!master || master.sourceId !== 'local'))
        throw new Error('This event is no longer available to edit.');
      const r: EventRecurrenceRule = single
        ? { frequency: 'none' }
        : {
            ...draft.recurrence,
            until: ends === 'date' ? draft.recurrence.until : undefined,
            count: ends === 'count' ? draft.recurrence.count : undefined,
          };
      if (
        !draft.allDay &&
        (!multi || !draft.endDate || draft.endDate === draft.date) &&
        draft.startTime &&
        draft.endTime &&
        draft.endTime <= draft.startTime
      )
        throw new Error('Choose an end time after the start time.');
      const parsed = eventSchema.safeParse({
        id,
        sourceId: 'local',
        externalId: master?.externalId,
        title: draft.title.trim(),
        date: draft.date,
        endDate: multi ? draft.endDate || draft.date : undefined,
        allDay: draft.allDay,
        startTime: draft.allDay ? undefined : draft.startTime,
        endTime: draft.allDay ? undefined : draft.endTime,
        timeZone: draft.timeZone,
        memberIds: draft.memberIds,
        recurrence: r,
        location: draft.location?.trim(),
        notes: draft.notes?.trim(),
        reminderMinutes: draft.reminderMinutes,
      });
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? 'Check the event details.');
      const value = parsed.data;
      attemptedSave = true;
      ownAttempt.current = true;
      await store.mutate([
        master
          ? {
              type: 'event.edit',
              id,
              recurrenceDate: event?.recurrenceDate ?? master.date,
              scope,
              value,
              newSeriesId: scope === 'future' ? futureId : undefined,
            }
          : { type: 'event.put', value },
      ]);
      store.setNotice(master ? 'Calendar event updated' : 'Added to the family calendar');
      onClose();
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : 'Could not save.') +
          (attemptedSave ? ' Your entries are still here. Try saving again.' : ''),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={master ? 'Edit your plan' : 'Make a little plan'}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form className="editor-form local-event-editor" onSubmit={submit}>
        <fieldset className="event-fields" disabled={saving || store.sync.canRetrySave}>
          <p className="form-intro">
            {master?.recurrence.frequency !== 'none' && master
              ? 'Editing ' +
                scopes.find(([s]) => s === scope)?.[1] +
                '. Changing dates, times or repeat patterns clears modified occurrences in this range; other changes keep them.'
              : 'A small plan makes room for the good stuff.'}
          </p>
          <label>
            Event name
            <input
              autoFocus
              required
              maxLength={120}
              value={draft.title}
              onChange={(e) => change({ title: e.target.value })}
              placeholder="e.g. Soccer practice"
            />
          </label>
          <label>
            {master && scope === 'all' && master.recurrence.frequency !== 'none'
              ? 'Series start date'
              : 'Date'}
            <input
              required
              type="date"
              value={draft.date}
              onChange={(e) => change({ date: e.target.value })}
            />
          </label>
          <label className="simple-checkbox">
            <input
              type="checkbox"
              checked={draft.allDay}
              onChange={(e) => change({ allDay: e.target.checked })}
            />
            All-day event
          </label>
          {!draft.allDay && (
            <div className="form-columns">
              <label>
                Starts
                <input
                  required
                  type="time"
                  value={draft.startTime ?? '09:00'}
                  onChange={(e) => change({ startTime: e.target.value })}
                />
              </label>
              <label>
                Ends
                <input
                  required
                  type="time"
                  value={draft.endTime ?? '10:00'}
                  onChange={(e) => change({ endTime: e.target.value })}
                />
              </label>
            </div>
          )}
          <label className="simple-checkbox">
            <input
              type="checkbox"
              checked={multi}
              onChange={(e) => {
                setMulti(e.target.checked);
                change({ endDate: draft.endDate ?? draft.date });
              }}
            />
            Multiple days
          </label>
          {multi && (
            <label>
              End date
              <input
                required
                type="date"
                min={draft.date}
                value={draft.endDate ?? draft.date}
                onChange={(e) => change({ endDate: e.target.value })}
              />
            </label>
          )}
          <fieldset>
            <legend>Family members</legend>
            <div className="assign-members">
              <button
                type="button"
                aria-pressed={!draft.memberIds.length}
                className={!draft.memberIds.length ? 'selected' : ''}
                onClick={() => change({ memberIds: [] })}
              >
                Everyone
              </button>
              {store.family.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  aria-pressed={draft.memberIds.includes(p.id)}
                  className={draft.memberIds.includes(p.id) ? 'selected' : ''}
                  onClick={() =>
                    change({
                      memberIds: draft.memberIds.includes(p.id)
                        ? draft.memberIds.filter((id) => id !== p.id)
                        : [...draft.memberIds, p.id],
                    })
                  }
                >
                  <Avatar id={p.id} small />
                  {p.name}
                </button>
              ))}
            </div>
          </fieldset>
          {!single && (
            <>
              <label>
                Repeat
                <select
                  aria-label="Repeat"
                  value={repeat}
                  onChange={(e) => chooseRepeat(e.target.value)}
                >
                  {[
                    ['none', 'Does not repeat'],
                    ['daily', 'Daily'],
                    ['weekdays', 'Every weekday'],
                    ['weekly', 'Weekly'],
                    ['biweekly', 'Every 2 weeks'],
                    ['monthly', 'Monthly'],
                    ['yearly', 'Yearly'],
                    ['custom', 'Custom'],
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              {repeat === 'custom' && (
                <div className="recurrence-controls">
                  <div className="form-columns">
                    <label>
                      Every
                      <input
                        required
                        type="number"
                        min={1}
                        max={999}
                        value={draft.recurrence.interval ?? 1}
                        onChange={(e) => rule({ interval: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      Repeat unit
                      <select
                        value={draft.recurrence.frequency}
                        onChange={(e) =>
                          change({
                            recurrence: {
                              frequency: e.target.value as EventRecurrenceRule['frequency'],
                              interval: draft.recurrence.interval ?? 1,
                              until: draft.recurrence.until,
                              count: draft.recurrence.count,
                            },
                          })
                        }
                      >
                        {[
                          ['daily', 'days'],
                          ['weekly', 'weeks'],
                          ['monthly', 'months'],
                          ['yearly', 'years'],
                        ].map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {draft.recurrence.frequency === 'weekly' && (
                    <fieldset>
                      <legend>On</legend>
                      <div className="weekday-picker">
                        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                          <label key={d} className="simple-checkbox">
                            <input
                              type="checkbox"
                              aria-label={
                                [
                                  'Sunday',
                                  'Monday',
                                  'Tuesday',
                                  'Wednesday',
                                  'Thursday',
                                  'Friday',
                                  'Saturday',
                                ][d]
                              }
                              checked={(
                                draft.recurrence.byWeekday ?? [weekday(draft.date)]
                              ).includes(d)}
                              onChange={() => {
                                const selected = draft.recurrence.byWeekday ?? [
                                  weekday(draft.date),
                                ];
                                rule({
                                  byWeekday: selected.includes(d)
                                    ? selected.filter((v) => v !== d)
                                    : [...selected, d],
                                });
                              }}
                            />
                            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  {draft.recurrence.frequency === 'monthly' && (
                    <>
                      <label>
                        Monthly pattern
                        <select
                          value={draft.recurrence.monthWeek ? 'weekday' : 'date'}
                          onChange={(e) =>
                            rule({
                              monthWeek: e.target.value === 'weekday' ? 1 : undefined,
                              byWeekday:
                                e.target.value === 'weekday' ? [weekday(draft.date)] : undefined,
                            })
                          }
                        >
                          <option value="date">Same day of month</option>
                          <option value="weekday">A weekday of the month</option>
                        </select>
                      </label>
                      {draft.recurrence.monthWeek && (
                        <div className="form-columns">
                          <label>
                            Which week
                            <select
                              value={draft.recurrence.monthWeek}
                              onChange={(e) => rule({ monthWeek: Number(e.target.value) })}
                            >
                              {[
                                [1, 'First'],
                                [2, 'Second'],
                                [3, 'Third'],
                                [4, 'Fourth'],
                                [5, 'Fifth'],
                                [-1, 'Last'],
                              ].map(([v, l]) => (
                                <option key={v} value={v}>
                                  {l}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Weekday
                            <select
                              value={draft.recurrence.byWeekday?.[0]}
                              onChange={(e) => rule({ byWeekday: [Number(e.target.value)] })}
                            >
                              {[
                                'Sunday',
                                'Monday',
                                'Tuesday',
                                'Wednesday',
                                'Thursday',
                                'Friday',
                                'Saturday',
                              ].map((d, i) => (
                                <option value={i} key={d}>
                                  {d}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {repeat !== 'none' && (
                <>
                  <label>
                    Repeat ends
                    <select
                      value={ends}
                      onChange={(e) => {
                        setEnds(e.target.value);
                        rule({
                          until:
                            e.target.value === 'date'
                              ? (draft.recurrence.until ?? draft.date)
                              : undefined,
                          count:
                            e.target.value === 'count' ? (draft.recurrence.count ?? 10) : undefined,
                        });
                      }}
                    >
                      <option value="never">Never</option>
                      <option value="date">On date</option>
                      <option value="count">After occurrences</option>
                    </select>
                  </label>
                  {ends === 'date' && (
                    <label>
                      Repeat until
                      <input
                        required
                        type="date"
                        min={draft.date}
                        value={draft.recurrence.until ?? ''}
                        onChange={(e) => rule({ until: e.target.value })}
                      />
                    </label>
                  )}
                  {ends === 'count' && (
                    <label>
                      Number of occurrences
                      <input
                        required
                        type="number"
                        min={1}
                        max={10000}
                        value={draft.recurrence.count ?? 10}
                        onChange={(e) => rule({ count: Number(e.target.value) })}
                      />
                    </label>
                  )}
                </>
              )}
            </>
          )}
          <details open={!!master} className="event-more">
            <summary>Location, notes & reminder</summary>
            <div className="event-fields">
              <label>
                Location
                <input
                  maxLength={160}
                  value={draft.location ?? ''}
                  onChange={(e) => change({ location: e.target.value })}
                />
              </label>
              <label>
                Notes
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={draft.notes ?? ''}
                  onChange={(e) => change({ notes: e.target.value })}
                />
              </label>
              <label>
                Reminder setting
                <select
                  value={draft.reminderMinutes ?? ''}
                  onChange={(e) =>
                    change({
                      reminderMinutes: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                >
                  {[
                    ['', 'None'],
                    [0, 'At event time'],
                    [10, '10 minutes before'],
                    [30, '30 minutes before'],
                    [60, '1 hour before'],
                    [1440, '1 day before'],
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                  {draft.reminderMinutes !== undefined &&
                    ![0, 10, 30, 60, 1440].includes(draft.reminderMinutes) && (
                      <option value={draft.reminderMinutes}>
                        {draft.reminderMinutes} minutes before
                      </option>
                    )}
                </select>
              </label>
              <small className="muted">
                Saved for future reminders. Notifications are not sent yet.
              </small>
            </div>
          </details>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="outline-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : master ? 'Save event' : 'Add event'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function EventDetail({
  event,
  onClose,
  onEdit,
}: {
  event: EventOccurrence;
  onClose: () => void;
  onEdit: (scope: EventScope) => void;
}) {
  const store = useHousehold(),
    { family, sources } = store;
  const [action, setAction] = useState<'edit' | 'delete' | null>(null),
    [scope, setScope] = useState<EventScope>('this'),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const [original] = useState(() =>
    fingerprint([
      store.events.find((e) => e.id === event.id),
      store.eventExceptions.filter((e) => e.eventId === event.id),
    ]),
  );
  const ownDelete = useRef(false);
  const repeating = event.recurrence.frequency !== 'none';
  const source = sources.find((s) => s.id === event.sourceId);
  const sourceLabel =
    source?.provider === 'google'
      ? 'Google Calendar'
      : source?.provider === 'icloud'
        ? 'iCloud Calendar'
        : event.sourceId === 'local'
          ? 'Family Dashboard'
          : 'Demo calendar';
  async function remove() {
    setSaving(true);
    setError('');
    try {
      if (store.sync.canRetrySave) {
        await store.retrySave();
        if (ownDelete.current) {
          onClose();
          return;
        }
      }
      if (
        original !==
        fingerprint([
          store.events.find((e) => e.id === event.id),
          store.eventExceptions.filter((e) => e.eventId === event.id),
        ])
      )
        throw new Error('This event changed. Close and reopen it before deleting.');
      ownDelete.current = true;
      await store.mutate([
        {
          type: 'event.delete',
          id: event.id,
          recurrenceDate: event.recurrenceDate,
          scope: repeating ? scope : 'all',
        },
      ]);
      store.setNotice('Calendar event removed');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove this event.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={
        action
          ? action === 'edit'
            ? 'Edit recurring event'
            : repeating
              ? 'Delete recurring event'
              : 'Delete event'
          : event.title
      }
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="event-detail">
        {action ? (
          <>
            <p>
              {action === 'delete'
                ? 'Remove this plan from the family calendar?'
                : 'Which dates would you like to change?'}
            </p>
            {repeating && (
              <ScopePicker
                value={scope}
                onChange={setScope}
                disabled={saving || store.sync.canRetrySave}
              />
            )}
            <p className="muted">
              {scope === 'this'
                ? 'Only this occurrence changes.'
                : scope === 'future'
                  ? 'Earlier occurrences stay in place. A new series starts here when editing.'
                  : 'The whole series changes, including earlier dates.'}
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button className="outline-button" disabled={saving} onClick={() => setAction(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={saving}
                onClick={() => (action === 'edit' ? onEdit(scope) : void remove())}
              >
                {saving ? 'Removing…' : action === 'edit' ? 'Continue' : 'Confirm delete'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              <CalendarDays size={21} />
              <span>
                {formatDate(event.date, { weekday: 'long', month: 'long', day: 'numeric' })}
                {event.endDate && event.endDate !== event.date
                  ? ' – ' + formatDate(event.endDate, { month: 'long', day: 'numeric' })
                  : ''}
                <small>
                  {event.allDay
                    ? 'All day'
                    : formatTime(event.startTime) + ' – ' + formatTime(event.endTime)}
                </small>
              </span>
            </p>
            {event.location && (
              <p>
                <MapPin size={21} />
                {event.location}
              </p>
            )}
            {repeating && (
              <p>
                <Repeat2 size={21} />
                {recurrenceLabel(event.recurrence)}
              </p>
            )}
            {event.isException && (
              <p className="muted">
                Modified occurrence · Originally {formatDate(event.recurrenceDate)}
              </p>
            )}
            <div className="event-members">
              {!event.memberIds.length ? (
                <span>Everyone</span>
              ) : (
                family
                  .filter((p) => event.memberIds.includes(p.id))
                  .map((p) => (
                    <span key={p.id}>
                      <Avatar id={p.id} small />
                      {p.name}
                    </span>
                  ))
              )}
            </div>
            {event.notes && <p className="event-notes">{event.notes}</p>}
            <p className="muted">
              {sourceLabel} · {source?.name}
              {event.sourceId !== 'local' && ' · Read-only'} · {event.timeZone}
            </p>
            {event.sourceId === 'local' && (
              <div className="form-actions">
                <button className="outline-button" onClick={() => setAction('delete')}>
                  <Trash2 size={18} />
                  Delete event
                </button>
                <button
                  className="primary"
                  onClick={() => (repeating ? setAction('edit') : onEdit('all'))}
                >
                  <Pencil size={18} />
                  Edit event
                </button>
              </div>
            )}
            <button className="outline-button full-width" onClick={onClose}>
              Lovely, got it
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
