import { useEffect, useState } from 'react';
import { LockKeyhole, UnlockKeyhole } from 'lucide-react';
import { lockOperator, operatorUnlocked, unlockOperator } from '../data/operator';

export function RewardOperator({ onChange }: { onChange?: () => void }) {
  const [unlocked, setUnlocked] = useState(operatorUnlocked);
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => {
      if (unlocked && !operatorUnlocked()) {
        setUnlocked(false);
        onChange?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [unlocked, onChange]);
  async function unlock() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await unlockOperator(pin);
      setPin('');
      setUnlocked(true);
      setOpen(false);
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unlock.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="operator-access">
      <button
        type="button"
        className="outline-button"
        onClick={() => {
          if (unlocked) {
            lockOperator();
            setUnlocked(false);
            onChange?.();
          } else setOpen(!open);
        }}
      >
        {unlocked ? <UnlockKeyhole size={17} /> : <LockKeyhole size={17} />}
        {unlocked ? 'Lock operator controls' : 'Unlock operator controls'}
      </button>
      {open && (
        <div className="operator-pin">
          <label>
            Operator PIN
            <input
              type="password"
              autoComplete="off"
              maxLength={128}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void unlock();
                }
              }}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy || !pin}
            onClick={() => void unlock()}
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
          <small>Operator access lasts 15 minutes and locks when this page reloads.</small>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
