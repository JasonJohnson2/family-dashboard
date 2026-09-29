import { useEffect, useState } from 'react';
import { Modal } from './ui';
import { RewardOperator } from './RewardOperator';
import { operatorHeaders, operatorUnlocked } from '../data/operator';
import { accessRequest } from '../data/access';
type Device = {
  id: string;
  name: string;
  trusted: number;
  createdAt: number;
  expiresAt: number;
  current: boolean;
};
export function HouseholdSecurity({ onClose }: { onClose: () => void }) {
  const [unlocked, setUnlocked] = useState(operatorUnlocked);
  const [devices, setDevices] = useState<Device[]>([]);
  const [credential, setCredential] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    kind: 'logout' | 'credential' | 'revoke';
    device?: Device;
  }>();
  const signout = () => window.dispatchEvent(new Event('household-signout'));
  async function load() {
    try {
      setDevices((await accessRequest('devices', undefined, operatorHeaders())).devices);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load devices.');
    }
  }
  useEffect(() => {
    if (unlocked) void load();
    else setDevices([]);
  }, [unlocked]);
  return (
    <Modal title="Household privacy" onClose={onClose}>
      <div className="household-security">
        <p>
          Your trusted devices can open this home. Member selection stays separate from household
          access.
        </p>
        <button
          className="outline-button full-width"
          onClick={() => setConfirm({ kind: 'logout' })}
        >
          Lock this device
        </button>
        <RewardOperator
          onChange={() => {
            setUnlocked(operatorUnlocked());
            setError('');
          }}
        />
        {!unlocked && (
          <p className="muted">
            Unlock operator controls to view devices or change household access.
          </p>
        )}
        {unlocked && (
          <>
            <h3>Trusted devices & browsers</h3>
            <p className="muted">
              Dates show when access was granted. We don’t track browsing or update last-used
              records.
            </p>
            {!devices.length && <p role="status">No device records loaded.</p>}
            <ul className="device-list">
              {devices.map((device) => (
                <li key={device.id}>
                  <div>
                    <strong>
                      {device.name}
                      {device.current ? ' · This device' : ''}
                    </strong>
                    <small>
                      {device.trusted ? 'Trusted' : '12-hour session'} · Added{' '}
                      {new Date(device.createdAt).toLocaleDateString()}
                      <br />
                      Expires {new Date(device.expiresAt).toLocaleDateString()}
                    </small>
                  </div>
                  <button
                    className="outline-button"
                    disabled={busy}
                    aria-label={`Revoke ${device.name}`}
                    onClick={() => setConfirm({ kind: 'revoke', device })}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setConfirm({ kind: 'credential' });
              }}
            >
              <h3>Change household access</h3>
              <p>
                This signs out every device, including this one. Save your new credential in a
                password manager first.
              </p>
              <label>
                New household credential
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={20}
                  maxLength={128}
                  required
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                />
              </label>
              <label>
                Confirm new credential
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={20}
                  maxLength={128}
                  required
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                />
              </label>
              <small>
                Use 20–128 characters, preferably a generated password or several random words.
              </small>
              <button
                className="primary full-width"
                disabled={busy || credential.length < 20 || credential !== repeat}
              >
                Review credential change
              </button>
            </form>
          </>
        )}
        {confirm && (
          <div className="security-confirm" role="group" aria-label="Confirm security change">
            <p>
              {confirm.kind === 'credential'
                ? 'Change access and sign out all devices?'
                : confirm.kind === 'logout'
                  ? 'Lock this browser? You will need the household credential to open it again.'
                  : `Revoke access for ${confirm.device?.name}?`}
            </p>
            <div className="form-actions">
              <button
                className="outline-button"
                disabled={busy}
                onClick={() => setConfirm(undefined)}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    if (confirm.kind === 'logout') {
                      await accessRequest('logout', {});
                      signout();
                    } else if (confirm.kind === 'credential') {
                      await accessRequest('credential', { credential }, operatorHeaders());
                      setCredential('');
                      setRepeat('');
                      signout();
                    } else {
                      await accessRequest('revoke', { id: confirm.device!.id }, operatorHeaders());
                      if (confirm.device!.current) signout();
                      else await load();
                    }
                    setConfirm(undefined);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Could not save. Please retry.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Saving…' : 'Confirm security change'}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
