import { useEffect, useState } from 'react';
import {
  CalendarDays,
  CheckCheck,
  Heart,
  House,
  ListChecks,
  Settings2,
  Users,
  Utensils,
  WifiOff,
} from 'lucide-react';
import { Home, type EditorKind } from './components/Home';
import { Calendar } from './components/Calendar';
import { Chores, Lists, Meals } from './components/Sections';
import { Editor, EventDetail } from './components/Editors';
import { Avatar } from './components/ui';
import { useHousehold } from './store';
import { formatDate } from './lib/dates';
import type { EventOccurrence, Section } from './types';

const navigation = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'chores', label: 'Chores', icon: CheckCheck },
  { id: 'meals', label: 'Meals', icon: Utensils },
  { id: 'lists', label: 'Lists', icon: ListChecks },
] as const;
function getSection(): Section {
  const section = location.hash.slice(1);
  return navigation.some((item) => item.id === section) ? (section as Section) : 'home';
}
export default function App() {
  const { today, family, notice } = useHousehold();
  const [section, setSection] = useState<Section>(getSection);
  const [editor, setEditor] = useState<{
    kind: EditorKind;
    date?: string;
    newList?: boolean;
  } | null>(null);
  const [event, setEvent] = useState<EventOccurrence | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const onHash = () => {
      setSection(getSection());
      window.scrollTo({ top: 0 });
    };
    const onNetwork = () => setOnline(navigator.onLine);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('online', onNetwork);
    window.addEventListener('offline', onNetwork);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('online', onNetwork);
      window.removeEventListener('offline', onNetwork);
    };
  }, []);
  useEffect(() => {
    document.title = `${navigation.find((item) => item.id === section)?.label} · Our Home`;
  }, [section]);
  function navigate(next: Section) {
    location.hash = next;
    setSection(next);
  }
  const open = (kind: EditorKind, date?: string) => setEditor({ kind, date });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <>
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to main content
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <a className="brand" href="#home" aria-label="Our Home dashboard">
            <div className="brand-mark">
              <House size={37} strokeWidth={1.7} />
              <Heart size={13} fill="currentColor" />
            </div>
            <strong>
              Our Home<span className="brand-dot">.</span>
            </strong>
            <span>Better days, together.</span>
          </a>
          <nav aria-label="Main navigation">
            {navigation.map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#${id}`}
                aria-label={label}
                className={section === id ? 'nav-item active' : 'nav-item'}
                aria-current={section === id ? 'page' : undefined}
              >
                <Icon size={22} strokeWidth={section === id ? 2.3 : 1.7} />
                <span>{label}</span>
                {section === id && <i />}
              </a>
            ))}
          </nav>
          <div className="sidebar-secondary">
            <button className="nav-item" onClick={() => open('family')}>
              <Users size={22} strokeWidth={1.7} />
              Our family
            </button>
            <button className="nav-item" onClick={() => open('about')}>
              <Settings2 size={22} strokeWidth={1.7} />
              About this home
            </button>
          </div>
          <div className="sidebar-footer">
            <Heart size={22} />
            <p>
              A happier home,
              <br />
              one little day at a time.
            </p>
            <span>MADE FOR OUR PEOPLE</span>
          </div>
        </aside>
        <main id="main" tabIndex={-1}>
          <header className="hero">
            <div className="hero-copy">
              <span className="hero-eyebrow">OUR LITTLE CORNER OF THE WORLD</span>
              <h1>
                {section === 'home' ? (
                  <>
                    {greeting}
                    <span className="greeting-dot">.</span>
                  </>
                ) : (
                  navigation.find((item) => item.id === section)?.label
                )}
              </h1>
              <p>{formatDate(today, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            </div>
            <div className="hero-right">
              <div className="hero-quote">
                Small steps.
                <br />
                Brighter days.
                <Heart size={16} />
              </div>
              <button
                className="family-avatars"
                aria-label="Manage family members"
                onClick={() => open('family')}
              >
                {family.slice(0, 5).map((person) => (
                  <Avatar key={person.id} id={person.id} />
                ))}
                {family.length > 5 && <span className="avatar">+{family.length - 5}</span>}
              </button>
              <button
                className="hero-settings icon-button"
                aria-label="About and installation"
                onClick={() => open('about')}
              >
                <Settings2 size={25} />
              </button>
            </div>
          </header>
          <div className="main-content">
            {section === 'home' && <Home navigate={navigate} open={open} viewEvent={setEvent} />}
            {section === 'calendar' && (
              <Calendar open={(date) => open('event', date)} viewEvent={setEvent} />
            )}
            {section === 'chores' && <Chores open={() => open('chore')} />}
            {section === 'meals' && <Meals open={(date) => open('meal', date)} />}
            {section === 'lists' && (
              <Lists open={() => setEditor({ kind: 'list', newList: true })} />
            )}
            <footer className="app-footer">
              <span>
                <span className="status-dot" />
                {online ? (
                  'A little space for your family'
                ) : (
                  <>
                    <WifiOff size={13} /> Offline · Your home is still here
                  </>
                )}
              </span>
              <button onClick={() => open('about')}>Demo data · Resets on refresh</button>
            </footer>
          </div>
        </main>
      </div>
      <div className={`toast ${notice ? 'visible' : ''}`} role="status" aria-live="polite">
        {notice}
      </div>
      {editor && (
        <Editor key={`${editor.kind}-${editor.date}`} {...editor} onClose={() => setEditor(null)} />
      )}
      {event && <EventDetail event={event} onClose={() => setEvent(null)} />}
    </>
  );
}
