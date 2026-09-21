import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Repeat2 } from 'lucide-react';
import { useHousehold } from '../store';
import { everyoneColor } from '../data/mock';
import {
  addDays,
  daysFrom,
  eventsOn,
  formatDate,
  formatTime,
  parseDate,
  shiftMonth,
  weekStart,
} from '../lib/dates';
import { colorStyle, Empty, EventRow, MemberFilter } from './ui';
import type { EventOccurrence } from '../types';

export function Calendar({
  open,
  viewEvent,
}: {
  open: (date: string) => void;
  viewEvent: (event: EventOccurrence) => void;
}) {
  const { today, events, family, sources } = useHousehold();
  const [view, setView] = useState<'day' | 'week' | 'month'>('week');
  const [date, setDate] = useState(today);
  const [member, setMember] = useState('all');
  const visible = events.filter(
    (e) => member === 'all' || e.memberIds.includes(member) || e.memberIds.length === 0,
  );
  const days =
    view === 'month'
      ? daysFrom(weekStart(`${date.slice(0, 7)}-01`), 42)
      : view === 'week'
        ? daysFrom(weekStart(date), 7)
        : [date];
  function move(direction: number) {
    setDate(
      view === 'month'
        ? shiftMonth(date, direction)
        : addDays(date, direction * (view === 'week' ? 7 : 1)),
    );
  }
  return (
    <section className="section-page">
      <div className="page-toolbar">
        <div>
          <span className="eyebrow">A little more together</span>
          <h2>Family calendar</h2>
        </div>
        <button className="primary" onClick={() => open(date)}>
          <Plus size={18} />
          Add event
        </button>
      </div>
      <div className="calendar-panel card">
        <div className="calendar-toolbar">
          <div className="date-navigation">
            <button
              className="icon-button"
              aria-label={`Previous ${view}`}
              onClick={() => move(-1)}
            >
              <ChevronLeft size={22} />
            </button>
            <h3>{formatDate(date, { month: 'long', year: 'numeric' })}</h3>
            <button className="icon-button" aria-label={`Next ${view}`} onClick={() => move(1)}>
              <ChevronRight size={22} />
            </button>
            <button className="outline-button" onClick={() => setDate(today)}>
              Today
            </button>
          </div>
          <div className="segmented" aria-label="Calendar view">
            {(['day', 'week', 'month'] as const).map((item) => (
              <button
                key={item}
                className={view === item ? 'active' : ''}
                aria-pressed={view === item}
                onClick={() => setView(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <MemberFilter selected={member} onChange={setMember} />
        {view === 'day' ? (
          <div className="day-agenda">
            <div className="agenda-heading">
              <CalendarDays size={28} />
              <div>
                <h3>{formatDate(date, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
                <p>{eventsOn(visible, date).length} things on the horizon</p>
              </div>
            </div>
            {eventsOn(visible, date).map((e) => (
              <div className="agenda-event" key={e.occurrenceId}>
                <EventRow event={e} onClick={() => viewEvent(e)} />
                <div className="agenda-meta">
                  {e.location || 'Time together'} ·{' '}
                  {e.memberIds.length
                    ? e.memberIds.map((id) => family.find((p) => p.id === id)?.name).join(', ')
                    : 'Everyone'}
                </div>
              </div>
            ))}
            {!eventsOn(visible, date).length && (
              <Empty>Nothing on the calendar. Make a little plan?</Empty>
            )}
          </div>
        ) : (
          <div className={`calendar-grid ${view}`}>
            {days.map((day) => {
              const dayEvents = eventsOn(visible, day);
              return (
                <div
                  key={day}
                  className={`calendar-cell ${day === today ? 'current-day' : ''} ${day.slice(0, 7) !== date.slice(0, 7) && view === 'month' ? 'other-month' : ''}`}
                >
                  <button
                    className="cell-date"
                    aria-label={`View ${formatDate(day, { month: 'long', day: 'numeric' })}`}
                    onClick={() => {
                      setDate(day);
                      setView('day');
                    }}
                  >
                    <span>{formatDate(day, { weekday: 'short' })}</span>
                    <b>{parseDate(day).getDate()}</b>
                  </button>
                  <div className="cell-events">
                    {dayEvents.map((e) => (
                      <button
                        key={e.occurrenceId}
                        aria-label={`${e.allDay ? 'All day' : formatTime(e.startTime)} ${e.title}`}
                        className="calendar-event"
                        style={colorStyle(
                          family.find((p) => p.id === e.memberIds[0])?.color ?? everyoneColor,
                        )}
                        onClick={() => viewEvent(e)}
                      >
                        <span>
                          {e.allDay ? 'All day' : formatTime(e.startTime)}
                          {e.recurrence.frequency !== 'none' && <Repeat2 size={11} />}
                        </span>
                        <strong>{e.title}</strong>
                      </button>
                    ))}
                    {view === 'week' && dayEvents.length === 0 && (
                      <span className="free-day">Room to breathe</span>
                    )}
                  </div>
                  <button
                    className="cell-add"
                    aria-label={`Add event on ${day}`}
                    onClick={() => open(day)}
                  >
                    <Plus size={17} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <footer className="calendar-legend">
          <span className="dot" />
          Our Home calendar
          <span className="legend-note">
            {sources.some((s) => s.provider === 'google')
              ? 'Google Calendar · Read only · Apple/iCloud integration planned'
              : 'Apple/iCloud integration planned · No calendars connected'}
          </span>
        </footer>
      </div>
    </section>
  );
}
