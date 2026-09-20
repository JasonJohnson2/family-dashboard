import { useRef, useState, type FormEvent } from 'react';
import { Heart, MapPin, Repeat2, CalendarDays, Trash2, Pencil } from 'lucide-react';
import { useHousehold } from '../store';
import { formatDate, formatTime } from '../lib/dates';
import { newId } from '../lib/id';
import { eventSchema } from '../data/contracts';
import { Avatar, Modal } from './ui';
import type { EditorKind } from './Home';
import type { CalendarEvent, EventOccurrence, Recurrence } from '../types';

const sameEvent = (a: CalendarEvent, b?: CalendarEvent) =>
  !!b && JSON.stringify(eventSchema.parse(a)) === JSON.stringify(eventSchema.parse(b));

const repeatOptions: [Recurrence, string][] = [
  ['none', 'Does not repeat'],
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Every week'],
  ['monthly', 'Every month'],
];

export function Editor({
  kind,
  date,
  onClose,
  newList = false,
  eventId,
}: {
  kind: EditorKind;
  date?: string;
  onClose: () => void;
  newList?: boolean;
  eventId?: string;
}) {
  const store = useHousehold();
  const {
    today,
    family,
    setFamily,
    setEvents,
    setChores,
    meals,
    setMeals,
    lists,
    setLists,
    addItem,
    setNotice,
  } = store;
  const [existingEvent] = useState(() =>
    eventId ? store.events.find((event) => event.id === eventId) : undefined,
  );
  const lastAttempt = useRef<CalendarEvent | undefined>(undefined);
  const [day, setDay] = useState(existingEvent?.date ?? date ?? today);
  const [endDate, setEndDate] = useState(existingEvent?.endDate ?? '');
  const [until, setUntil] = useState(existingEvent?.recurrence.until ?? '');
  const existingMeal = meals.find((m) => m.date === day);
  const [title, setTitle] = useState(
    existingEvent?.title ?? (kind === 'meal' ? (existingMeal?.title ?? '') : ''),
  );
  const [memberIds, setMemberIds] = useState<string[]>(existingEvent?.memberIds ?? []);
  const [recurrence, setRecurrence] = useState<Recurrence>(
    existingEvent?.recurrence.frequency ?? 'none',
  );
  const [start, setStart] = useState(existingEvent?.startTime ?? '09:00');
  const [end, setEnd] = useState(existingEvent?.endTime ?? '10:00');
  const [allDay, setAllDay] = useState(existingEvent?.allDay ?? false);
  const [location, setLocation] = useState(existingEvent?.location ?? '');
  const [emoji, setEmoji] = useState(existingMeal?.emoji ?? '🍽️');
  const [notes, setNotes] = useState(
    kind === 'event' ? (existingEvent?.notes ?? '') : (existingMeal?.notes ?? ''),
  );
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [id] = useState(() => eventId ?? newId());
  const [familyDraft, setFamilyDraft] = useState(family);
  const heading = {
    event: eventId ? 'Edit your plan' : 'Make a little plan',
    chore: 'Share the little jobs',
    meal: existingMeal ? 'On the menu' : 'Plan something delicious',
    list: newList ? 'A fresh list' : 'Add to a shared list',
    family: 'Our people',
    about: 'Welcome to Our Home',
  }[kind];
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError('');
    setSaving(true);
    try {
      if (store.sync.canRetrySave) await store.retrySave();
      if (kind === 'family') {
        if (familyDraft.some((p) => !p.name.trim())) {
          setError('Please give everyone a name.');
          return;
        }
        await setFamily(
          familyDraft.map((p) => ({
            ...p,
            name: p.name.trim(),
            initial: p.name.trim().slice(0, 1).toUpperCase(),
          })),
        );
        setNotice('Family updated');
        onClose();
        return;
      }
      if (!title.trim()) {
        setError('Add a name to continue.');
        return;
      }
      if (kind === 'event' && endDate && endDate < day) {
        setError('Choose an end date on or after the start date.');
        return;
      }
      if (kind === 'event' && recurrence !== 'none' && until && until < day) {
        setError('Choose a repeat end on or after the first date.');
        return;
      }
      if (kind === 'event' && !allDay && (!endDate || endDate === day) && end <= start) {
        setError('Choose an end time after the start time.');
        return;
      }
      if (kind === 'event') {
        if (eventId && (!existingEvent || existingEvent.sourceId !== 'local'))
          throw new Error(
            'This event is no longer available to edit. Close this form and refresh.',
          );
        const next: CalendarEvent = {
          ...existingEvent,
          id,
          sourceId: existingEvent?.sourceId ?? 'local',
          title: title.trim(),
          date: day,
          endDate: endDate || undefined,
          startTime: allDay ? undefined : start,
          endTime: allDay ? undefined : end,
          allDay,
          timeZone: existingEvent?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          memberIds,
          recurrence: {
            frequency: recurrence,
            until: recurrence === 'none' ? undefined : until || undefined,
          },
          location: location.trim(),
          notes: notes.trim(),
        };
        await setEvents((current) => {
          if (eventId) {
            const latest = current.find((event) => event.id === eventId);
            if (!latest) throw new Error('This event was removed. Close this form and refresh.');
            if (!sameEvent(latest, existingEvent) && !sameEvent(latest, lastAttempt.current))
              throw new Error(
                'This event changed while you were editing. Close and reopen it to review the latest version.',
              );
          }
          lastAttempt.current = next;
          return current.some((event) => event.id === id)
            ? current.map((event) => (event.id === id ? next : event))
            : [...current, next];
        });
      }
      if (kind === 'chore')
        await setChores((current) => [
          ...current.filter((value) => value.id !== id),
          {
            id,
            title: title.trim(),
            memberIds,
            dueDate: day,
            recurrence: { frequency: recurrence },
            completedDates: [],
          },
        ]);
      if (kind === 'meal')
        await setMeals((current) => [
          ...current.filter((meal) => meal.date !== day),
          {
            id: existingMeal?.id ?? id,
            date: day,
            title: title.trim(),
            emoji,
            notes: notes.trim(),
            recipeId: existingMeal?.recipeId,
          },
        ]);
      if (kind === 'list') {
        if (newList) {
          if (
            lists.some((l) => l.id !== id && l.name.toLowerCase() === title.trim().toLowerCase())
          ) {
            setError('There is already a list with that name.');
            return;
          }
          await setLists((current) => [
            ...current.filter((l) => l.id !== id),
            { id, name: title.trim(), items: current.find((l) => l.id === id)?.items ?? [] },
          ]);
        } else await addItem(listId, title, id);
      }
      setNotice(
        kind === 'event'
          ? eventId
            ? 'Calendar event updated'
            : 'Added to the family calendar'
          : kind === 'chore'
            ? 'A little teamwork, planned'
            : kind === 'meal'
              ? 'Dinner is planned'
              : newList
                ? 'Your new list is ready'
                : 'Added to your list',
      );
      onClose();
    } catch (failure) {
      setError(
        (failure instanceof Error ? failure.message : 'Could not save.') +
          ' Your entries are still here. Try saving again.',
      );
    } finally {
      setSaving(false);
    }
  }
  if (kind === 'about')
    return (
      <Modal title={heading} onClose={onClose}>
        <div className="about-content">
          <div className="about-heart">
            <Heart size={36} />
          </div>
          <h3>
            A little less planning.
            <br />A little more together.
          </h3>
          <p>
            Calendar events, chores, meals, and lists are saved to your household. Refresh or return
            to the app to see changes from your other devices.
          </p>
          <h4>Make it feel like home</h4>
          <p>
            On iPad, open in Safari, tap Share, then <strong>Add to Home Screen</strong>. Launch
            from that icon for a full-screen app experience. Installation and offline support need
            HTTPS (or localhost).
          </p>
          <p className="muted">
            No accounts or connected calendars yet. Weather is a sample. An internet connection is
            needed to load and save household data.
          </p>
          <button className="primary full-width" onClick={onClose}>
            Make yourself at home
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={heading}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form className="editor-form" onSubmit={submit}>
        <fieldset disabled={saving} className="editor-fields">
          <p className="form-intro">
            {kind === 'family'
              ? 'The people who make this place home.'
              : existingEvent?.recurrence.frequency !== undefined &&
                  existingEvent.recurrence.frequency !== 'none'
                ? 'You are editing the whole repeating series, including past and future dates.'
                : 'A small plan makes a little more room for the good stuff.'}
          </p>
          {kind === 'family' ? (
            <div className="family-editor">
              {familyDraft.map((person, i) => (
                <div className="family-edit-row" key={person.id}>
                  <Avatar id={person.id} />
                  <label>
                    <span>Member {i + 1}</span>
                    <input
                      aria-label={`Member ${i + 1} name`}
                      maxLength={30}
                      required
                      value={person.name}
                      onChange={(e) =>
                        setFamilyDraft((current) =>
                          current.map((p) =>
                            p.id === person.id ? { ...p, name: e.target.value } : p,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="color-label">
                    <span>Color</span>
                    <input
                      type="color"
                      aria-label={`Member ${i + 1} color`}
                      value={person.color}
                      onChange={(e) => {
                        const color = e.target.value;
                        setFamilyDraft((current) =>
                          current.map((p) =>
                            p.id === person.id ? { ...p, color, tint: `${color}20` } : p,
                          ),
                        );
                      }}
                    />
                  </label>
                </div>
              ))}
              <button
                type="button"
                className="soft-button"
                onClick={() =>
                  setFamilyDraft((current) => [
                    ...current,
                    {
                      id: newId(),
                      name: '',
                      initial: '?',
                      color: '#347a72',
                      tint: '#deeeeb',
                    },
                  ])
                }
              >
                + Add family member
              </button>
            </div>
          ) : (
            <>
              <label>
                {kind === 'list'
                  ? newList
                    ? 'List name'
                    : 'What do we need?'
                  : kind === 'meal'
                    ? 'What’s for dinner?'
                    : kind === 'chore'
                      ? 'What needs doing?'
                      : 'Event name'}
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                  required
                  placeholder={
                    kind === 'event'
                      ? 'e.g. A picnic in the park'
                      : kind === 'chore'
                        ? 'e.g. Take out the recycling'
                        : kind === 'meal'
                          ? 'e.g. Homemade pizza'
                          : newList
                            ? 'e.g. Weekend projects'
                            : 'e.g. Fresh strawberries'
                  }
                />
              </label>
              {kind !== 'list' && (
                <label>
                  {kind === 'chore'
                    ? 'First due date'
                    : eventId && recurrence !== 'none'
                      ? 'Series start date'
                      : 'Date'}
                  <input
                    type="date"
                    value={day}
                    required
                    onChange={(e) => {
                      setDay(e.target.value);
                      if (kind === 'meal') {
                        const meal = meals.find((m) => m.date === e.target.value);
                        setTitle(meal?.title ?? '');
                        setEmoji(meal?.emoji ?? '🍽️');
                        setNotes(meal?.notes ?? '');
                      }
                    }}
                  />
                </label>
              )}
              {kind === 'event' && (
                <>
                  {existingEvent?.endDate && (
                    <label>
                      End date
                      <input
                        type="date"
                        value={endDate}
                        min={day}
                        onChange={(e) => setEndDate(e.target.value)}
                      />
                    </label>
                  )}
                  <label className="simple-checkbox">
                    <input
                      type="checkbox"
                      checked={allDay}
                      onChange={(e) => setAllDay(e.target.checked)}
                    />
                    All-day event
                  </label>
                  {!allDay && (
                    <div className="form-columns">
                      <label>
                        Starts
                        <input
                          type="time"
                          required
                          value={start}
                          onChange={(e) => setStart(e.target.value)}
                        />
                      </label>
                      <label>
                        Ends
                        <input
                          type="time"
                          required
                          value={end}
                          onChange={(e) => setEnd(e.target.value)}
                        />
                      </label>
                    </div>
                  )}
                  <label>
                    Location <span className="optional">(optional)</span>
                    <input
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      maxLength={160}
                      placeholder="A place to be together"
                    />
                  </label>
                </>
              )}
              {(kind === 'event' || kind === 'chore') && (
                <>
                  <fieldset>
                    <legend>Who's it for?</legend>
                    <div className="assign-members">
                      <button
                        type="button"
                        aria-pressed={!memberIds.length}
                        className={!memberIds.length ? 'selected' : ''}
                        onClick={() => setMemberIds([])}
                      >
                        Everyone
                      </button>
                      {family.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={memberIds.includes(p.id)}
                          className={memberIds.includes(p.id) ? 'selected' : ''}
                          onClick={() =>
                            setMemberIds((current) =>
                              current.includes(p.id)
                                ? current.filter((id) => id !== p.id)
                                : [...current, p.id],
                            )
                          }
                        >
                          <Avatar id={p.id} small />
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label>
                    Repeat
                    <select
                      aria-label="Repeat"
                      value={recurrence}
                      onChange={(e) => setRecurrence(e.target.value as Recurrence)}
                    >
                      {repeatOptions.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {kind === 'event' && eventId && recurrence !== 'none' && (
                <label>
                  Repeat until <span className="optional">(optional)</span>
                  <input
                    type="date"
                    value={until}
                    min={day}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </label>
              )}
              {kind === 'event' && (
                <label>
                  Notes <span className="optional">(optional)</span>
                  <textarea
                    rows={2}
                    maxLength={2000}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Anything to remember?"
                  />
                </label>
              )}
              {kind === 'meal' && (
                <>
                  <fieldset>
                    <legend>A little flavor</legend>
                    <div className="emoji-picker">
                      {['🍽️', '🌮', '🍝', '🥘', '🍕', '🍔', '🥗', '🍲'].map((icon, i) => (
                        <button
                          type="button"
                          key={icon}
                          aria-label={
                            [
                              'Dinner',
                              'Tacos',
                              'Pasta',
                              'Stir fry',
                              'Pizza',
                              'Burgers',
                              'Salad',
                              'Soup',
                            ][i]
                          }
                          aria-pressed={emoji === icon}
                          className={emoji === icon ? 'selected' : ''}
                          onClick={() => setEmoji(icon)}
                        >
                          {icon}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label>
                    Notes <span className="optional">(optional)</span>
                    <textarea
                      rows={2}
                      maxLength={500}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Anything to prep ahead?"
                    />
                  </label>
                </>
              )}
              {kind === 'list' && !newList && (
                <label>
                  Add to
                  <select value={listId} onChange={(e) => setListId(e.target.value)}>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="form-actions">
            {kind === 'meal' && existingMeal && (
              <button
                type="button"
                className="icon-button delete-button"
                aria-label="Remove meal"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await setMeals((current) => current.filter((m) => m.date !== day));
                    setNotice('Meal removed');
                    onClose();
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : 'Could not remove meal.');
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <Trash2 size={19} />
              </button>
            )}
            <button type="button" className="outline-button" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {saving
                ? 'Saving…'
                : kind === 'event' && eventId
                  ? 'Save event'
                  : kind === 'family'
                    ? 'Save family'
                    : kind === 'meal'
                      ? 'Save meal'
                      : kind === 'list' && newList
                        ? 'Create list'
                        : 'Add ' + (kind === 'list' ? 'item' : kind)}
            </button>
          </div>
          <p className="demo-note">Changes are saved to your household</p>
        </fieldset>
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
  onEdit: () => void;
}) {
  const { family, sources } = useHousehold();
  return (
    <Modal title={event.title} onClose={onClose}>
      <div className="event-detail">
        <p>
          <CalendarDays size={21} />
          <span>
            {formatDate(event.occurrenceDate, { weekday: 'long', month: 'long', day: 'numeric' })}
            <small>
              {event.allDay
                ? 'All day'
                : `${formatTime(event.startTime)} – ${formatTime(event.endTime)}`}
            </small>
          </span>
        </p>
        {event.location && (
          <p>
            <MapPin size={21} />
            {event.location}
          </p>
        )}
        {event.recurrence.frequency !== 'none' && (
          <p>
            <Repeat2 size={21} />
            Repeats {event.recurrence.frequency}
          </p>
        )}
        <div className="event-members">
          {(event.memberIds.length
            ? family.filter((p) => event.memberIds.includes(p.id))
            : family
          ).map((p) => (
            <span key={p.id}>
              <Avatar id={p.id} small />
              {p.name}
            </span>
          ))}
        </div>
        {event.notes && <p className="event-notes">{event.notes}</p>}
        <p className="muted">
          {sources.find((s) => s.id === event.sourceId)?.name} · {event.timeZone}
        </p>
        {event.sourceId === 'local' && (
          <button className="primary full-width" onClick={onEdit}>
            <Pencil size={18} />
            Edit event
          </button>
        )}
        <button className="outline-button full-width" onClick={onClose}>
          Lovely, got it
        </button>
      </div>
    </Modal>
  );
}
