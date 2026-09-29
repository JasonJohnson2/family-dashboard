import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Heart, House, LockKeyhole } from 'lucide-react';
import { accessRequest, privateFetch } from '../data/access';
import { lockOperator } from '../data/operator';

export function HouseholdAccess({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [covered, setCovered] = useState(false);
  const [error, setError] = useState('');
  const [credential, setCredential] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const authenticatedRef = useRef(false);
  function lock() {
    epoch.current++;
    authenticatedRef.current = false;
    lockOperator();
    window.dispatchEvent(new Event('household-locked'));
    setAuthenticated(false);
    setChecking(false);
    setCovered(false);
    setCredential('');
    setError('');
  }
  async function check() {
    const current = ++epoch.current;
    try {
      const response = await privateFetch('/api/auth/session', {
        signal: AbortSignal.timeout(15_000),
      });
      if (current !== epoch.current) return;
      if (response.ok) {
        authenticatedRef.current = true;
        setAuthenticated(true);
        setCovered(false);
        setChecking(false);
        setError('');
      } else if (response.status === 401) lock();
      else throw new Error();
    } catch {
      if (current !== epoch.current) return;
      setChecking(false);
      setCovered(true);
      setError('Reconnect to verify household access, then try again.');
    }
  }
  useEffect(() => {
    void check();
    const unauthorized = () => {
      const hadAccess = authenticatedRef.current;
      lock();
      if (hadAccess)
        setError(
          'Please sign in to continue. Any unconfirmed changes may need to be entered again.',
        );
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        epoch.current++;
        setCovered(true);
      } else void check();
    };
    const focus = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setCovered(true);
        void check();
      }
    };
    window.addEventListener('household-unauthorized', unauthorized);
    window.addEventListener('household-signout', lock);
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    window.addEventListener('pageshow', pageShow);
    document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => {
      if (authenticatedRef.current && document.visibilityState === 'visible') void check();
    }, 60_000);
    return () => {
      epoch.current++;
      clearInterval(timer);
      window.removeEventListener('household-unauthorized', unauthorized);
      window.removeEventListener('household-signout', lock);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
      window.removeEventListener('pageshow', pageShow);
      document.removeEventListener('visibilitychange', visibility);
    };
    // The gate owns a single session lifecycle; handlers use refs for current authorization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!authenticated) document.title = 'Welcome home · Our Home';
  }, [authenticated]);
  return (
    <>
      {authenticated && <div hidden={covered || checking}>{children}</div>}
      {(!authenticated || covered || checking) && (
        <main className="access-screen">
          <section className="access-card" aria-labelledby="access-title">
            <div className="access-brand">
              <House size={35} />
              <span>
                Our Home<span className="brand-dot">.</span>
              </span>
            </div>
            <span className="eyebrow">OUR LITTLE CORNER OF THE WORLD</span>
            <h1 id="access-title">Welcome home</h1>
            {checking ? (
              <p role="status">Checking household access…</p>
            ) : covered ? (
              <>
                <p>Your household stays private while we reconnect.</p>
                {error && (
                  <p role="alert" className="form-error">
                    {error}
                  </p>
                )}
                <button
                  className="primary full-width"
                  onClick={() => {
                    setChecking(true);
                    void check();
                  }}
                >
                  Try again
                </button>
              </>
            ) : (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (busy) return;
                  setBusy(true);
                  setError('');
                  try {
                    await accessRequest('login', { credential, trusted, name });
                    setCredential('');
                    await check();
                  } catch (failure) {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : 'Could not sign in. Please retry.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <p>Enter your household access credential to come inside.</p>
                <label>
                  Household access credential
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                    value={credential}
                    onChange={(e) => setCredential(e.target.value)}
                  />
                </label>
                <label className="access-trust">
                  <input
                    type="checkbox"
                    checked={trusted}
                    onChange={(e) => setTrusted(e.target.checked)}
                  />
                  <span>
                    Trust this device
                    <small>Stay signed in for up to 180 days. Use on your own devices.</small>
                  </span>
                </label>
                <label>
                  Device name <span className="muted">(optional)</span>
                  <input
                    maxLength={80}
                    autoComplete="off"
                    placeholder="Kitchen dashboard"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                {error && (
                  <p role="alert" className="form-error">
                    {error}
                  </p>
                )}
                <button type="submit" className="primary full-width" disabled={busy || !credential}>
                  <LockKeyhole size={18} />
                  {busy ? 'Opening your home…' : 'Enter dashboard'}
                </button>
                <small className="muted">
                  Without trust, this browser stays signed in for 12 hours.
                </small>
              </form>
            )}
            <p className="access-footer">
              <Heart size={15} /> A little more together.
            </p>
          </section>
        </main>
      )}
    </>
  );
}
