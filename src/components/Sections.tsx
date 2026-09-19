import { useState, type CSSProperties } from 'react';
import { CheckCheck, ChevronLeft, ChevronRight, Plus, Repeat2, Utensils } from 'lucide-react';
import { useHousehold } from '../store';
import { addDays, daysFrom, formatDate, occursOn, weekStart } from '../lib/dates';
import { ChoreRow, Empty, MemberFilter } from './ui';
import { QuickList } from './QuickList';

export function Chores({ open }: { open: () => void }) {
  const { today, chores } = useHousehold();
  const [day, setDay] = useState(today);
  const [member, setMember] = useState('all');
  const [filter, setFilter] = useState('all');
  const due = chores.filter(
    (chore) =>
      occursOn(chore.dueDate, day, chore.recurrence) &&
      (member === 'all' || chore.memberIds.includes(member) || chore.memberIds.length === 0),
  );
  const complete = due.filter((c) => c.completedDates.includes(day)).length;
  const visible = due.filter(
    (c) =>
      filter === 'all' ||
      (filter === 'done' ? c.completedDates.includes(day) : !c.completedDates.includes(day)),
  );
  const overdue = chores.filter(
    (c) =>
      c.recurrence.frequency === 'none' &&
      c.dueDate < day &&
      !c.completedDates.includes(c.dueDate) &&
      (member === 'all' || c.memberIds.length === 0 || c.memberIds.includes(member)),
  );
  return (
    <section className="section-page">
      <div className="page-toolbar">
        <div>
          <span className="eyebrow">Many hands, lighter days</span>
          <h2>A little teamwork</h2>
        </div>
        <button className="primary" onClick={open}>
          <Plus size={18} />
          Add chore
        </button>
      </div>
      <div className="chore-layout">
        <div className="card large-card">
          <div className="calendar-toolbar">
            <div className="date-navigation">
              <button
                className="icon-button"
                aria-label="Previous day"
                onClick={() => setDay(addDays(day, -1))}
              >
                <ChevronLeft />
              </button>
              <h3>
                {day === today
                  ? "Today's chores"
                  : formatDate(day, { weekday: 'short', month: 'short', day: 'numeric' })}
              </h3>
              <button
                className="icon-button"
                aria-label="Next day"
                onClick={() => setDay(addDays(day, 1))}
              >
                <ChevronRight />
              </button>
            </div>
            <button className="outline-button" onClick={() => setDay(today)}>
              Today
            </button>
          </div>
          <MemberFilter selected={member} onChange={setMember} />
          <div className="segmented chore-tabs">
            {[
              ['all', 'All chores'],
              ['todo', 'To do'],
              ['done', 'Completed'],
            ].map(([id, label]) => (
              <button
                key={id}
                className={filter === id ? 'active' : ''}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {visible.map((chore) => (
            <ChoreRow key={chore.id} chore={chore} day={day} detail />
          ))}
          {!visible.length && (
            <Empty>
              {filter === 'done'
                ? 'Small steps count. Check off your first chore.'
                : 'All clear here. Enjoy a little downtime.'}
            </Empty>
          )}
          {overdue.length > 0 && filter !== 'done' && (
            <div className="overdue">
              <h3>Still to do</h3>
              {overdue.map((c) => (
                <div key={c.id}>
                  <ChoreRow chore={c} day={c.dueDate} detail />
                  <small>Due {formatDate(c.dueDate)}</small>
                </div>
              ))}
            </div>
          )}
        </div>
        <aside className="chore-aside">
          <div className="team-card">
            <div
              className="completion-ring"
              style={
                {
                  '--progress': `${due.length ? (complete / due.length) * 100 : 0}%`,
                } as CSSProperties
              }
            >
              <div>
                <CheckCheck size={27} />
                <strong>
                  {complete}
                  <span>/{due.length}</span>
                </strong>
              </div>
            </div>
            <h3>Every little bit helps.</h3>
            <p>
              {complete === due.length && due.length
                ? 'Everything is taken care of. Thanks, team!'
                : 'Small jobs. Shared effort. More time for the good stuff.'}
            </p>
            <span className="eyebrow">You've got this, together.</span>
          </div>
          <div className="card note-card">
            <Repeat2 size={22} />
            <h3>A fresh start</h3>
            <p>
              Repeating chores get a fresh checkbox for each due date. Yesterday's effort always
              counts.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

export function Meals({ open }: { open: (day: string) => void }) {
  const { today, meals } = useHousehold();
  const [week, setWeek] = useState(weekStart(today));
  const days = daysFrom(week, 7);
  const count = days.filter((day) => meals.some((m) => m.date === day)).length;
  return (
    <section className="section-page">
      <div className="page-toolbar">
        <div>
          <span className="eyebrow">Around the same table</span>
          <h2>What's for dinner?</h2>
        </div>
        <button className="primary" onClick={() => open(today)}>
          <Plus size={18} />
          Plan a meal
        </button>
      </div>
      <div className="meal-week-bar card">
        <div className="date-navigation">
          <button
            className="icon-button"
            aria-label="Previous week"
            onClick={() => setWeek(addDays(week, -7))}
          >
            <ChevronLeft />
          </button>
          <h3>
            {formatDate(week, { month: 'short', day: 'numeric' })} –{' '}
            {formatDate(addDays(week, 6), { month: 'short', day: 'numeric', year: 'numeric' })}
          </h3>
          <button
            className="icon-button"
            aria-label="Next week"
            onClick={() => setWeek(addDays(week, 7))}
          >
            <ChevronRight />
          </button>
          <button className="outline-button" onClick={() => setWeek(weekStart(today))}>
            This week
          </button>
        </div>
        <span>{count} of 7 dinners planned</span>
      </div>
      <div className="meal-planner">
        {days.map((day) => {
          const meal = meals.find((m) => m.date === day);
          return (
            <button
              key={day}
              className={`meal-day-card ${day === today ? 'today' : ''}`}
              onClick={() => open(day)}
            >
              <header>
                <span>{formatDate(day, { weekday: 'long' })}</span>
                <b>{formatDate(day, { day: 'numeric', month: 'short' })}</b>
                {day === today && <em>Today</em>}
              </header>
              <div className={`meal-illustration ${meal ? '' : 'no-meal'}`}>
                {meal ? <span>{meal.emoji}</span> : <Utensils size={42} strokeWidth={1} />}
              </div>
              <h3>{meal?.title ?? 'A little inspiration?'}</h3>
              <p>
                {meal?.notes ||
                  (meal ? 'Dinner · Made for sharing' : 'Tap to plan something delicious')}
              </p>
              <span className="meal-edit">
                {meal ? 'Edit meal' : 'Add a meal'}
                <Plus size={16} />
              </span>
            </button>
          );
        })}
        <div className="meal-note">
          <HeartDecoration />
          <p>
            The best part of dinner
            <br />
            is who's around the table.
          </p>
          <span>Recipes & grocery planning, later.</span>
        </div>
      </div>
    </section>
  );
}
function HeartDecoration() {
  return <span className="heart-decoration">♡</span>;
}
export function Lists({ open }: { open: () => void }) {
  return (
    <section className="section-page">
      <div className="page-toolbar">
        <div>
          <span className="eyebrow">Out of your head, onto a list</span>
          <h2>The things we need</h2>
        </div>
        <button className="primary" onClick={open}>
          <Plus size={18} />
          New list
        </button>
      </div>
      <div className="lists-layout">
        <div className="card large-card">
          <QuickList full />
        </div>
        <aside className="list-note">
          <span>✓</span>
          <h3>
            Less remembering.
            <br />
            More living.
          </h3>
          <p>One place for groceries, little errands, and all the things that keep home running.</p>
          <div className="note-divider" />
          <small>
            Prototype changes last until refresh.
            <br />
            Household sync will come later.
          </small>
        </aside>
      </div>
    </section>
  );
}
