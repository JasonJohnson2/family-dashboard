import { LocalEventEditor } from './LocalCalendarEditor';
export { EventDetail } from './LocalCalendarEditor';
import { RewardOperator } from './RewardOperator';
import { operatorUnlocked } from '../data/operator';
import { useState, type FormEvent } from 'react';
import { Heart, Trash2 } from 'lucide-react';
import { useHousehold } from '../store';
import { newId } from '../lib/id';
import { Avatar, Modal } from './ui';
import type { EditorKind } from './Home';
import type { EventOccurrence, Recurrence } from '../types';

const repeatOptions: [Recurrence, string][] = [
  ['none', 'Does not repeat'],
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Every week'],
  ['monthly', 'Every month'],
];

function HouseholdEditor({
  kind,
  date,
  onClose,
  newList = false,
  choreId,
}: {
  kind: Exclude<EditorKind, 'event'>;
  date?: string;
  onClose: () => void;
  newList?: boolean;
  choreId?: string;
}) {
  const store = useHousehold();
  const {
    today,
    family,
    setFamily,
    setChores,
    meals,
    setMeals,
    lists,
    setLists,
    addItem,
    setNotice,
  } = store;
  const [existingChore] = useState(() => store.chores.find((c) => c.id === choreId));
  const [stars, setStars] = useState(existingChore?.stars ?? 0);
  const [, renderOperator] = useState(0);
  const [day, setDay] = useState(existingChore?.dueDate ?? date ?? today);
  const [until, setUntil] = useState(existingChore?.recurrence.until ?? '');
  const existingMeal = meals.find((m) => m.date === day);
  const [title, setTitle] = useState(
    existingChore?.title ?? (kind === 'meal' ? (existingMeal?.title ?? '') : ''),
  );
  const [memberIds, setMemberIds] = useState<string[]>(existingChore?.memberIds ?? []);
  const [recurrence, setRecurrence] = useState<Recurrence>(
    existingChore?.recurrence.frequency ?? 'none',
  );
  const [emoji, setEmoji] = useState(existingMeal?.emoji ?? '🍽️');
  const [notes, setNotes] = useState(existingMeal?.notes ?? '');
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [id] = useState(() => choreId ?? newId());
  const [familyDraft, setFamilyDraft] = useState(family);
  const heading = {
    chore: choreId ? 'Edit this chore' : 'Share the little jobs',
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
      if (kind === 'chore')
        await setChores((current) => [
          ...current.filter((value) => value.id !== id),
          {
            id,
            title: title.trim(),
            memberIds,
            dueDate: day,
            stars,
            recurrence: {
              frequency: recurrence,
              until: recurrence === 'none' ? undefined : until || undefined,
            },
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
        kind === 'chore'
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
              ? 'The people who make this place home. Mark children to enable Rewards. Roles do not grant operator access; changing a role keeps all reward history.'
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
                  <label className="member-role">
                    <span>Member type</span>
                    <select
                      aria-label={`Member ${i + 1} type`}
                      value={person.role}
                      onChange={(e) =>
                        setFamilyDraft((current) =>
                          current.map((p) =>
                            p.id === person.id
                              ? { ...p, role: e.target.value as 'adult' | 'child' }
                              : p,
                          ),
                        )
                      }
                    >
                      <option value="adult">Adult</option>
                      <option value="child">Child</option>
                    </select>
                    <small>
                      {person.role === 'child'
                        ? 'Can earn stars and redeem rewards.'
                        : 'Does not participate in stars or rewards.'}
                    </small>
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
                      role: 'adult',
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
                    kind === 'chore'
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
                  {kind === 'chore' ? 'First due date' : 'Date'}
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
              {kind === 'chore' && (
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
              {kind === 'chore' && recurrence !== 'none' && (
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
              {kind === 'chore' && (
                <div className="chore-star-editor">
                  <label>
                    Reward stars
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      step={1}
                      required
                      value={stars}
                      disabled={!operatorUnlocked()}
                      onChange={(e) => setStars(Number(e.target.value))}
                    />
                  </label>
                  <small>
                    Optional · Only children earn stars. Adults can complete without stars. An
                    operator unlocks star values.
                  </small>
                  <RewardOperator onChange={() => renderOperator((n) => n + 1)} />
                </div>
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
                : kind === 'chore' && choreId
                  ? 'Save chore'
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

export function Editor(
  props: Omit<Parameters<typeof HouseholdEditor>[0], 'kind'> & {
    kind: EditorKind;
    eventId?: string;
    event?: EventOccurrence;
    scope?: import('../types').EventScope;
  },
) {
  return props.kind === 'event' ? (
    <LocalEventEditor {...props} />
  ) : (
    <HouseholdEditor {...props} kind={props.kind} />
  );
}
