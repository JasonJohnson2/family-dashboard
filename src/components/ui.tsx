import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { ArrowRight, Check, ChevronRight, Repeat2, Pencil, X, type LucideIcon } from 'lucide-react';
import { useHousehold } from '../store';
import { everyoneColor } from '../data/mock';
import { eventTimeLabel } from '../lib/dates';
import type { Chore, EventOccurrence } from '../types';
// comment debug
export const colorStyle = (color: string): CSSProperties =>
  ({ '--member-color': color }) as CSSProperties;
export function Card({
  title,
  icon: Icon,
  tone = 'blue',
  action,
  actionLabel = 'View all',
  children,
  className = '',
}: {
  title: string;
  icon: LucideIcon;
  tone?: string;
  action?: () => void;
  actionLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      <header className="card-heading">
        <div className={`card-icon ${tone}`}>
          <Icon size={22} strokeWidth={2} />
        </div>
        <h2>{title}</h2>
        {action && (
          <button className="text-button" onClick={action}>
            {actionLabel}
            <ArrowRight size={15} />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <span>✧</span>
      <p>{children}</p>
    </div>
  );
}
export function Avatar({ id, small = false }: { id: string; small?: boolean }) {
  const { family } = useHousehold();
  const member = family.find((person) => person.id === id);
  return member ? (
    <span
      className={`avatar ${small ? 'small' : ''}`}
      style={{ background: member.tint, color: member.color }}
      title={member.name}
    >
      {member.initial}
    </span>
  ) : null;
}
export function MemberFilter({
  selected,
  onChange,
}: {
  selected: string;
  onChange: (id: string) => void;
}) {
  const { family } = useHousehold();
  return (
    <div className="member-filters" aria-label="Filter by family member">
      <button
        className={selected === 'all' ? 'filter active' : 'filter'}
        onClick={() => onChange('all')}
        aria-pressed={selected === 'all'}
      >
        Everyone
      </button>
      {family.map((person) => (
        <button
          key={person.id}
          aria-label={person.name}
          className={selected === person.id ? 'filter active' : 'filter'}
          onClick={() => onChange(person.id)}
          aria-pressed={selected === person.id}
        >
          <Avatar id={person.id} small />
          {person.name}
        </button>
      ))}
    </div>
  );
}
export function EventRow({
  event,
  onClick,
  compact = false,
}: {
  event: EventOccurrence;
  onClick: () => void;
  compact?: boolean;
}) {
  const { family } = useHousehold();
  const color = family.find((p) => p.id === event.memberIds[0])?.color ?? everyoneColor;
  return (
    <button className={`event-row ${compact ? 'compact' : ''}`} onClick={onClick}>
      <span className="dot" style={{ background: color }} />
      <time>{eventTimeLabel(event)}</time>
      <span className="event-title">{event.title}</span>
      {event.recurrence.frequency !== 'none' && !compact && <Repeat2 size={14} className="muted" />}
      <ChevronRight size={17} />
    </button>
  );
}
export function ChoreRow({
  chore,
  day,
  detail = false,
  onEdit,
}: {
  chore: Chore;
  day: string;
  detail?: boolean;
  onEdit?: () => void;
}) {
  const { family, toggleChore, sync } = useHousehold();
  const [confirm, setConfirm] = useState(false);
  const [actor, setActor] = useState(chore.memberIds[0] ?? '');
  const eligible = family.filter((m) => !chore.memberIds.length || chore.memberIds.includes(m.id));
  const member = family.find((p) => p.id === chore.memberIds[0]);
  const done = chore.completedDates.includes(day);
  return (
    <div className="chore-row-wrap">
      <label
        className={`chore-row ${done ? 'completed' : ''}`}
        style={colorStyle(member?.color ?? everyoneColor)}
      >
        <input
          type="checkbox"
          checked={done}
          disabled={!!sync.pending}
          onChange={() => {
            if (chore.stars && (done || eligible.length !== 1)) setConfirm(true);
            else toggleChore(chore.id, day, eligible[0]?.id);
          }}
        />
        <span className="check-visual">
          <Check size={15} />
        </span>
        <span className="chore-title">
          {chore.title}
          {!!chore.stars && <small className="chore-stars">+{chore.stars} ★</small>}
          {detail && (
            <small>
              {chore.recurrence.frequency === 'none' ? 'One-time' : chore.recurrence.frequency}{' '}
              {chore.recurrence.frequency !== 'none' && <Repeat2 size={12} />}
            </small>
          )}
        </span>
        <span className="chore-person">{member?.name ?? 'Everyone'}</span>
      </label>
      {onEdit && (
        <button
          className="icon-button chore-edit"
          aria-label={`Edit ${chore.title}`}
          onClick={onEdit}
        >
          <Pencil size={16} />
        </button>
      )}
      {confirm && (
        <Modal
          title={done ? 'Undo this chore?' : 'Who completed this chore?'}
          onClose={() => setConfirm(false)}
        >
          <div className="reward-confirm">
            <p>{chore.title}</p>
            {done ? (
              <p>
                Any original star award will be reversed, even if the member is now an adult. If
                those stars have been spent, restore Child status and ask an operator to restore the
                balance first.
              </p>
            ) : (
              <label>
                Completed by (children earn stars; adults complete without stars)
                <select value={actor} onChange={(e) => setActor(e.target.value)}>
                  <option value="">Choose a member</option>
                  {eligible.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="form-actions">
              <button className="outline-button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!done && !actor}
                onClick={() => {
                  toggleChore(chore.id, day, actor);
                  setConfirm(false);
                }}
              >
                {done
                  ? 'Undo completion'
                  : eligible.find((m) => m.id === actor)?.role === 'child'
                    ? 'Complete and earn stars'
                    : 'Complete chore'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="dialog-title"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={22} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
