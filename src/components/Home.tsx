import {
  CalendarDays,
  CheckCheck,
  Heart,
  ListChecks,
  MapPin,
  Plus,
  Sun,
  Utensils,
  Zap,
  ChevronRight,
} from 'lucide-react';
import { useHousehold } from '../store';
import { addDays, eventsOn, formatDate, occursOn } from '../lib/dates';
import { Card, ChoreRow, Empty, EventRow } from './ui';
import { QuickList } from './QuickList';
import type { EventOccurrence, Section } from '../types';
export type EditorKind = 'event' | 'chore' | 'meal' | 'list' | 'family' | 'about';
interface Props {
  navigate: (section: Section) => void;
  open: (kind: EditorKind, date?: string) => void;
  viewEvent: (event: EventOccurrence) => void;
}

export function Home({ navigate, open, viewEvent }: Props) {
  const { today, events, chores, meals } = useHousehold();
  const schedule = eventsOn(events, today);
  const todaysChores = chores.filter((chore) => occursOn(chore.dueDate, today, chore.recurrence));
  const upcomingMeals = meals
    .filter((meal) => meal.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);
  const completed = todaysChores.filter((chore) => chore.completedDates.includes(today)).length;
  return (
    <div className="home-grid">
      <div className="top-grid">
        <section className="weather-card">
          <span className="eyebrow">A little sunshine</span>
          <div className="weather-main">
            <Sun className="sun" size={72} strokeWidth={1.4} />
            <div>
              <div className="temperature">
                68<span>°</span>
              </div>
              <strong>Sunny</strong>
            </div>
          </div>
          <div className="weather-meta">
            <span>H: 76° &nbsp; L: 52°</span>
            <span>
              <MapPin size={14} /> Fonda, NY
            </span>
          </div>
          <span className="weather-demo">Sample weather</span>
        </section>
        <section className="quote-card">
          <span className="quote-mark">“</span>
          <p>
            A little progress
            <br />
            every day adds up
            <br />
            to big results.
          </p>
          <Heart size={21} fill="currentColor" strokeWidth={0} />
          <span className="eyebrow">One day at a time</span>
        </section>
        <Card
          title="Today at a glance"
          icon={CalendarDays}
          action={() => navigate('calendar')}
          actionLabel="Calendar"
          className="today-card"
        >
          <div className="schedule">
            {schedule.length ? (
              schedule
                .slice(0, 4)
                .map((event) => (
                  <EventRow
                    key={event.occurrenceId}
                    event={event}
                    onClick={() => viewEvent(event)}
                  />
                ))
            ) : (
              <Empty>A little room to breathe. Nothing planned today.</Empty>
            )}
          </div>
          {schedule.length > 4 && (
            <button className="text-button" onClick={() => navigate('calendar')}>
              See {schedule.length - 4} more events <ChevronRight size={15} />
            </button>
          )}
        </Card>
      </div>
      <div className="dashboard-columns">
        <div className="dashboard-column">
          <Card
            title="Today's chores"
            icon={CheckCheck}
            tone="purple"
            action={() => navigate('chores')}
          >
            <div className="chore-progress">
              <span>
                {completed === todaysChores.length && completed > 0
                  ? 'All done. Teamwork looks good on you!'
                  : 'A little teamwork goes a long way.'}
              </span>
              <b>
                {completed}/{todaysChores.length}
              </b>
            </div>
            <div className="progress-track">
              <span
                style={{
                  width: `${todaysChores.length ? (completed / todaysChores.length) * 100 : 0}%`,
                }}
              />
            </div>
            {todaysChores.length ? (
              todaysChores
                .slice(0, 5)
                .map((chore) => <ChoreRow key={chore.id} chore={chore} day={today} />)
            ) : (
              <Empty>No chores today. Enjoy the extra time.</Empty>
            )}
          </Card>
          <Card
            title="Coming up"
            icon={CalendarDays}
            tone="pink"
            action={() => navigate('calendar')}
          >
            <div className="upcoming">
              {[1, 2].map((offset) => {
                const day = addDays(today, offset);
                const items = eventsOn(events, day);
                return (
                  <div key={day}>
                    <h3>
                      {offset === 1 ? 'Tomorrow' : formatDate(day, { weekday: 'long' })}
                      <span>{formatDate(day, { month: 'short', day: 'numeric' })}</span>
                    </h3>
                    {items.length ? (
                      items
                        .slice(0, 3)
                        .map((event) => (
                          <EventRow
                            compact
                            key={event.occurrenceId}
                            event={event}
                            onClick={() => viewEvent(event)}
                          />
                        ))
                    ) : (
                      <p className="quiet-day">Nothing planned. Keep it open.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
        <div className="dashboard-column">
          <Card title="On the menu" icon={Utensils} tone="green" action={() => navigate('meals')}>
            <p className="card-subtitle">Good food. Better company.</p>
            {upcomingMeals.map((meal) => (
              <button className="meal-row" key={meal.id} onClick={() => open('meal', meal.date)}>
                <span className={meal.date === today ? 'meal-day is-today' : 'meal-day'}>
                  {meal.date === today ? 'Today' : formatDate(meal.date, { weekday: 'short' })}
                </span>
                <span className="meal-emoji">{meal.emoji}</span>
                <span>{meal.title}</span>
                <ChevronRight size={17} />
              </button>
            ))}
            {upcomingMeals.length === 0 && <Empty>Something delicious starts with a plan.</Empty>}
            <button className="menu-footer" onClick={() => navigate('meals')}>
              Plan a little, enjoy a lot <ChevronRight size={15} />
            </button>
          </Card>
          <div className="scenic-card">
            <p>
              A calmer home,
              <br />
              happier days.
            </p>
            <Heart size={25} />
            <span>Make room for what matters.</span>
          </div>
        </div>
        <div className="dashboard-column">
          <Card
            title="Quick lists"
            icon={ListChecks}
            tone="orange"
            action={() => navigate('lists')}
          >
            <QuickList />
          </Card>
          <Card title="Make a little plan" icon={Zap} tone="plain">
            <div className="quick-actions">
              {(
                [
                  { kind: 'event', label: 'Event', icon: CalendarDays, tone: 'blue' },
                  { kind: 'chore', label: 'Chore', icon: CheckCheck, tone: 'purple' },
                  { kind: 'meal', label: 'Meal', icon: Utensils, tone: 'green' },
                  { kind: 'list', label: 'List item', icon: ListChecks, tone: 'orange' },
                ] as const
              ).map(({ kind, label, icon: Icon, tone }) => (
                <button key={kind} onClick={() => open(kind)}>
                  <span className={tone}>
                    <Icon size={24} />
                  </span>
                  <small>
                    <Plus size={11} /> {label}
                  </small>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
