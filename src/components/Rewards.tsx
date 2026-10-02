import { useEffect, useState } from 'react';
import { ArrowRight, Gift, History, Plus, Settings2, Star, Trophy } from 'lucide-react';
import { useHousehold } from '../store';
import {
  alreadyRedeemed,
  childMembers,
  eligibleFor,
  rewardIcons,
  rewardSchema,
  starBalance,
  type Reward,
} from '../data/rewards';
import { operatorUnlocked } from '../data/operator';
import { newId } from '../lib/id';
import { Avatar, Card, Empty, Modal } from './ui';
import { RewardOperator } from './RewardOperator';
import type { Operation } from '../data/contracts';

export function HomeRewards({ manageFamily }: { manageFamily: () => void }) {
  const { family, starTransactions } = useHousehold();
  const children = childMembers(family);
  return (
    <Card
      title="Little efforts, lovely rewards"
      icon={Trophy}
      tone="peach"
      action={() => {
        location.hash = 'rewards';
      }}
      actionLabel="Rewards"
      className="home-rewards"
    >
      <div className="home-star-balances">
        {children.map((m) => (
          <span key={m.id}>
            <Avatar id={m.id} small />
            {m.name}
            <strong>
              <Star size={14} />
              {starBalance(starTransactions, m.id)}
            </strong>
          </span>
        ))}
      </div>
      {!children.length && (
        <div className="rewards-empty">
          <p>No kids are set up for Rewards yet.</p>
          <button className="outline-button" onClick={manageFamily}>
            Manage family
          </button>
        </div>
      )}
    </Card>
  );
}

export function Rewards({ manageFamily }: { manageFamily: () => void }) {
  const { family, rewards, redemptions, starTransactions, mutate, sync, setNotice } =
    useHousehold();
  const children = childMembers(family);
  const [householdHistory, setHouseholdHistory] = useState(false);
  const [selected, setSelected] = useState('');
  const memberId = children.some((m) => m.id === selected) ? selected : (children[0]?.id ?? '');
  const person = family.find((m) => m.id === memberId);
  const balance = starBalance(starTransactions, memberId);
  const [all, setAll] = useState(false);
  const [manage, setManage] = useState(false);
  const [history, setHistory] = useState(false);
  const [confirm, setConfirm] = useState<Reward | null>(null);
  const [redemptionId, setRedemptionId] = useState(newId);
  useEffect(() => {
    if (redemptions.some((r) => r.id === redemptionId)) setConfirm(null);
  }, [redemptions, redemptionId]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const visible = rewards.filter(
    (r) =>
      all || (r.active && eligibleFor(r, person) && !alreadyRedeemed(r, memberId, redemptions)),
  );
  const activity = [
    ...starTransactions
      .filter((t) => householdHistory || t.memberId === memberId)
      .map((t) => ({
        id: t.id,
        memberId: t.memberId,
        at: t.createdAt,
        note: t.note,
        amount: t.amount,
        status: '',
      })),
    ...redemptions
      .filter((r) => (householdHistory || r.memberId === memberId) && r.status !== 'redeemed')
      .map((r) => ({
        id: r.id,
        memberId: r.memberId,
        at: r.resolvedAt ?? r.createdAt,
        note: r.name,
        amount: 0,
        status:
          r.status === 'pending'
            ? 'Awaiting approval · no stars spent'
            : 'Declined · no stars spent',
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const pending = redemptions.filter((r) => r.status === 'pending');
  async function redeem() {
    if (!confirm || busy || sync.pending) return;
    setBusy(true);
    setError('');
    try {
      await mutate([{ type: 'reward.redeem', id: redemptionId, rewardId: confirm.id, memberId }]);
      setNotice(confirm.requiresApproval ? 'Request sent for approval' : 'Reward redeemed. Enjoy!');
      setConfirm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not redeem.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rewards-page">
      <div className="page-toolbar">
        <div>
          <span className="eyebrow">Little efforts. Lovely rewards.</span>
          <h2>Do tasks, earn stars, get rewarded!</h2>
        </div>
        <button className="outline-button" onClick={() => setManage(true)}>
          <Settings2 size={18} />
          Manage rewards
          {pending.length > 0 && <span className="request-count">{pending.length}</span>}
        </button>
      </div>
      <div className="member-rewards" aria-label="Choose a member for rewards">
        {children.map((m) => {
          const stars = starBalance(starTransactions, m.id);
          const next = rewards
            .filter(
              (r) =>
                r.active &&
                eligibleFor(r, m) &&
                !alreadyRedeemed(r, m.id, redemptions) &&
                r.starCost > stars,
            )
            .sort((a, b) => a.starCost - b.starCost)[0];
          return (
            <button
              key={m.id}
              className={`member-reward ${m.id === memberId ? 'selected' : ''}`}
              style={{ background: m.tint }}
              aria-pressed={m.id === memberId}
              onClick={() => setSelected(m.id)}
            >
              <Avatar id={m.id} />
              <div>
                <span>{m.name}</span>
                <strong>
                  <Star size={22} />
                  {stars}
                  <small>stars</small>
                </strong>
              </div>
              {next ? (
                <>
                  <progress
                    max={next.starCost}
                    value={stars}
                    aria-label={`${m.name}: progress toward ${next.name}`}
                  />
                  <small>
                    {next.starCost - stars} stars to {next.name}
                  </small>
                </>
              ) : (
                <small>
                  {stars ? 'Choose something to look forward to.' : 'Every little effort counts.'}
                </small>
              )}
            </button>
          );
        })}
      </div>
      {!children.length && (
        <div className="card rewards-empty">
          <h3>No kids are set up for Rewards yet.</h3>
          <p>
            Mark a household member as a Child in Family settings to start earning stars and
            redeeming rewards.
          </p>
          <button className="outline-button" onClick={manageFamily}>
            Manage family
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <button className="pending-banner" onClick={() => setManage(true)}>
          <Gift size={20} />
          {pending.length} reward {pending.length === 1 ? 'request is' : 'requests are'} waiting for
          an operator
          <ArrowRight size={18} />
        </button>
      )}
      <Card title={person ? `Rewards for ${person.name}` : 'Rewards'} icon={Gift} tone="pink">
        <div className="segmented reward-tabs">
          <button
            className={!all ? 'active' : ''}
            aria-pressed={!all}
            onClick={() => setAll(false)}
          >
            Available
          </button>
          <button className={all ? 'active' : ''} aria-pressed={all} onClick={() => setAll(true)}>
            All rewards
          </button>
        </div>
        <div className="reward-grid">
          {visible.map((r, index) => {
            const eligible = eligibleFor(r, person),
              used = alreadyRedeemed(r, memberId, redemptions);
            const waiting = redemptions.some(
              (d) => d.rewardId === r.id && d.memberId === memberId && d.status === 'pending',
            );
            const status = !r.active
              ? 'Inactive'
              : !eligible
                ? 'For other children'
                : used
                  ? 'Already enjoyed'
                  : waiting
                    ? 'Awaiting approval'
                    : balance < r.starCost
                      ? `${r.starCost - balance} more stars to go`
                      : r.requiresApproval
                        ? 'Requires operator approval'
                        : r.reusable
                          ? 'Enjoy again another day'
                          : 'One-time treat';
            return (
              <article key={r.id} className={`reward-card reward-tone-${index % 4}`}>
                <div className="reward-visual" aria-hidden="true">
                  {r.icon}
                </div>
                <div className="reward-card-body">
                  <h3>{r.name}</h3>
                  {r.description && <p>{r.description}</p>}
                  <strong className="star-price">
                    <Star size={21} />
                    {r.starCost}
                    <span>stars</span>
                  </strong>
                  {eligible && r.active && !used && (
                    <progress
                      max={r.starCost}
                      value={Math.min(balance, r.starCost)}
                      aria-label={`Progress toward ${r.name}`}
                    />
                  )}
                  <small>{status}</small>
                  <button
                    className="primary"
                    disabled={
                      !eligible ||
                      !r.active ||
                      used ||
                      waiting ||
                      balance < r.starCost ||
                      !!sync.pending ||
                      sync.canRetrySave
                    }
                    onClick={() => {
                      setRedemptionId(newId());
                      setConfirm(r);
                      setError('');
                    }}
                  >
                    {waiting ? 'Requested' : r.requiresApproval ? 'Request' : 'Redeem'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {!visible.length && (
          <Empty>
            {rewards.length
              ? 'No rewards available for this member yet.'
              : 'A little something to look forward to. Use Manage rewards to create your first reward.'}
          </Empty>
        )}
      </Card>
      {person && (
        <a className="earn-stars card" href="#chores">
          <span className="card-icon green">
            <Star size={24} />
          </span>
          <div>
            <h3>Earn more stars</h3>
            <p>Small jobs make a big difference. See what needs doing.</p>
          </div>
          <ArrowRight size={20} />
        </a>
      )}
      <Card
        title={
          householdHistory
            ? 'Household reward history'
            : person
              ? `${person.name}’s activity`
              : 'Recent activity'
        }
        icon={History}
        action={activity.length > 6 ? () => setHistory(!history) : undefined}
        actionLabel={history ? 'Show recent' : 'View history'}
      >
        <button
          className="outline-button"
          aria-pressed={householdHistory}
          onClick={() => setHouseholdHistory(!householdHistory)}
        >
          {householdHistory ? 'Selected child’s activity' : 'Household reward history'}
        </button>
        <p className="reward-history-intro">
          {householdHistory
            ? 'All past awards, requests and redemptions, including members who are now adults.'
            : person
              ? `${balance} stars · Every award and spend, accounted for.`
              : 'View household reward history to see past activity.'}
        </p>
        <div className="reward-activity">
          {activity.slice(0, history ? activity.length : 6).map((a) => (
            <div key={a.id} className="reward-activity-row">
              <Avatar id={a.memberId} small />
              <div>
                <span>
                  {householdHistory && (
                    <strong>{family.find((m) => m.id === a.memberId)?.name} · </strong>
                  )}
                  {a.note}
                </span>
                <small>
                  {a.status ||
                    new Date(a.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                </small>
                {a.status && <small>{new Date(a.at).toLocaleDateString()}</small>}
              </div>
              <strong className={a.amount < 0 ? 'spent' : 'earned'}>
                {a.amount ? `${a.amount > 0 ? '+' : ''}${a.amount} ★` : '—'}
              </strong>
            </div>
          ))}
        </div>
        {!activity.length && <Empty>Your star story starts with a little teamwork.</Empty>}
      </Card>
      {manage && <RewardManager onClose={() => setManage(false)} />}
      {confirm && (
        <Modal
          title={confirm.requiresApproval ? 'Request this reward?' : 'Enjoy this reward?'}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          <div className="reward-confirm">
            <span className="confirm-emoji">{confirm.icon}</span>
            <h3>{confirm.name}</h3>
            <p>
              {person?.name} · {confirm.starCost} stars
            </p>
            <p>
              {confirm.requiresApproval
                ? 'Stars will be spent only when an operator approves.'
                : `${balance - confirm.starCost} stars will remain after redemption.`}
            </p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button className="outline-button" disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || !!sync.pending || sync.canRetrySave}
                onClick={() => void redeem()}
              >
                {busy
                  ? 'Saving…'
                  : confirm.requiresApproval
                    ? 'Confirm request'
                    : 'Confirm redemption'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RewardManager({ onClose }: { onClose: () => void }) {
  const { rewards, family, redemptions, starTransactions, mutate, sync, setNotice } =
    useHousehold();
  const [, render] = useState(0);
  const unlocked = operatorUnlocked();
  const [draft, setDraft] = useState<Reward | null>(null);
  const children = childMembers(family);
  const [selectedMember, setMemberId] = useState('');
  const memberId = children.some((m) => m.id === selectedMember)
    ? selectedMember
    : (children[0]?.id ?? '');
  const [amount, setAmount] = useState('5');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; op: Operation } | null>(null);
  async function save(op: Operation) {
    if (busy || sync.pending || sync.canRetrySave) return;
    setBusy(true);
    setError('');
    try {
      await mutate([op]);
      setDraft(null);
      setConfirm(null);
      setNotice('Rewards updated');
      if (op.type === 'stars.adjust') setNote('');
    } catch (e) {
      setConfirm(null);
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  const pending = redemptions.filter((r) => r.status === 'pending');
  return (
    <Modal
      title="Manage rewards"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="reward-manager">
        <RewardOperator onChange={() => render((n) => n + 1)} />
        {!unlocked && (
          <p className="muted">
            Unlock to manage rewards, approve requests, adjust stars, or change chore star values.
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {unlocked && (
          <fieldset
            disabled={busy || !!sync.pending || sync.canRetrySave}
            className="reward-management-fields"
          >
            {confirm ? (
              <div className="confirm-action">
                <p>{confirm.text}</p>
                <div className="form-actions">
                  <button className="outline-button" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button className="primary" onClick={() => void save(confirm.op)}>
                    Confirm change
                  </button>
                </div>
              </div>
            ) : draft ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = rewardSchema.safeParse(draft);
                  if (!parsed.success) {
                    setError('Check the reward name, cost and selected members.');
                    return;
                  }
                  void save({ type: 'reward.put', value: parsed.data });
                }}
                className="reward-editor"
              >
                <label>
                  Reward name
                  <input
                    required
                    maxLength={120}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label>
                  Description
                  <textarea
                    maxLength={500}
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </label>
                <div className="form-row">
                  <label>
                    Icon
                    <select
                      value={draft.icon}
                      onChange={(e) =>
                        setDraft({ ...draft, icon: e.target.value as Reward['icon'] })
                      }
                    >
                      {rewardIcons.map((icon) => (
                        <option key={icon}>{icon}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Star cost
                    <input
                      type="number"
                      required
                      min={1}
                      max={100000}
                      step={1}
                      value={draft.starCost}
                      onChange={(e) => setDraft({ ...draft, starCost: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <label className="reward-check">
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                  />
                  Active
                </label>
                <label className="reward-check">
                  <input
                    type="checkbox"
                    checked={draft.reusable}
                    onChange={(e) => setDraft({ ...draft, reusable: e.target.checked })}
                  />
                  Reusable (can be enjoyed again)
                </label>
                <label className="reward-check">
                  <input
                    type="checkbox"
                    checked={draft.requiresApproval}
                    onChange={(e) => setDraft({ ...draft, requiresApproval: e.target.checked })}
                  />
                  Requires operator approval
                </label>
                <fieldset>
                  <legend>Available to</legend>
                  {draft.memberIds.some((id) => !children.some((m) => m.id === id)) && (
                    <p className="muted">
                      Previous recipients who are now adults remain ineligible. Choose All kids or
                      select children to replace that restriction.
                    </p>
                  )}
                  <div className="assignment-options">
                    <button
                      type="button"
                      aria-pressed={!draft.memberIds.length}
                      onClick={() => setDraft({ ...draft, memberIds: [] })}
                    >
                      All kids
                    </button>
                    {children.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        aria-pressed={draft.memberIds.includes(m.id)}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            memberIds: draft.memberIds.includes(m.id)
                              ? draft.memberIds.filter(
                                  (id) => id !== m.id && children.some((child) => child.id === id),
                                )
                              : [
                                  ...draft.memberIds.filter((id) =>
                                    children.some((child) => child.id === id),
                                  ),
                                  m.id,
                                ],
                          })
                        }
                      >
                        <Avatar id={m.id} small />
                        {m.name}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="form-actions">
                  <button type="button" className="outline-button" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                  <button className="primary">Save reward</button>
                </div>
              </form>
            ) : (
              <>
                <button
                  className="primary"
                  onClick={() =>
                    setDraft({
                      id: newId(),
                      name: '',
                      description: '',
                      icon: '🎁',
                      starCost: 20,
                      active: true,
                      reusable: true,
                      requiresApproval: false,
                      memberIds: [],
                    })
                  }
                >
                  <Plus size={18} />
                  Create reward
                </button>
                <div className="manage-reward-list">
                  {rewards.map((r) => (
                    <div key={r.id}>
                      <span>
                        {r.icon} {r.name}
                        <small>
                          {r.starCost} stars · {r.active ? 'Active' : 'Inactive'}
                        </small>
                      </span>
                      <button
                        className="outline-button"
                        aria-label={`Edit ${r.name}`}
                        onClick={() => setDraft(rewardSchema.strip().parse(r))}
                      >
                        Edit
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          setConfirm({
                            text: `${redemptions.some((d) => d.rewardId === r.id) ? 'Deactivate' : 'Delete'} ${r.name}? History is always retained.`,
                            op: redemptions.some((d) => d.rewardId === r.id)
                              ? {
                                  type: 'reward.put',
                                  value: { ...rewardSchema.strip().parse(r), active: false },
                                }
                              : { type: 'reward.delete', id: r.id },
                          })
                        }
                      >
                        {redemptions.some((d) => d.rewardId === r.id) ? 'Deactivate' : 'Delete'}
                      </button>
                    </div>
                  ))}
                </div>
                <h3>Pending requests {pending.length > 0 && `(${pending.length})`}</h3>
                {pending.map((r) => (
                  <div className="pending-request" key={r.id}>
                    <p>
                      <strong>
                        {family.find((m) => m.id === r.memberId)?.name} · {r.name}
                      </strong>
                      <small>
                        {r.starCost} stars · requested {new Date(r.createdAt).toLocaleDateString()}
                        {!children.some((m) => m.id === r.memberId) &&
                          ' · No longer a child; decline or update their member type before approving.'}
                      </small>
                    </p>
                    <div className="form-actions">
                      <button
                        className="outline-button"
                        onClick={() =>
                          setConfirm({
                            text: `Decline the request for ${r.name}? No stars will be spent.`,
                            op: { type: 'reward.resolve', id: r.id, approve: false },
                          })
                        }
                      >
                        Decline
                      </button>
                      <button
                        className="primary"
                        disabled={!children.some((m) => m.id === r.memberId)}
                        onClick={() =>
                          setConfirm({
                            text: `Approve ${r.name} and spend ${r.starCost} stars?`,
                            op: { type: 'reward.resolve', id: r.id, approve: true },
                          })
                        }
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                ))}
                {!pending.length && <p className="muted">All caught up. No requests waiting.</p>}
                <h3>Adjust stars</h3>
                {!children.length ? (
                  <p className="muted">No kids are set up for star adjustments yet.</p>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setConfirm({
                        text: `Adjust ${family.find((m) => m.id === memberId)?.name}’s stars by ${Number(amount) > 0 ? '+' : ''}${amount}? Reason: ${note}`,
                        op: { type: 'stars.adjust', memberId, amount: Number(amount), note },
                      });
                    }}
                    className="star-adjustment"
                  >
                    <label>
                      Member
                      <select
                        value={memberId}
                        required
                        onChange={(e) => setMemberId(e.target.value)}
                      >
                        {children.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="muted">
                      Current balance: {starBalance(starTransactions, memberId)} stars
                    </p>
                    <label>
                      Adjustment (positive or negative)
                      <input
                        type="number"
                        required
                        min={-100000}
                        max={100000}
                        step={1}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                    </label>
                    <label>
                      Reason
                      <input
                        required
                        maxLength={200}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </label>
                    <button
                      className="outline-button"
                      disabled={!memberId || !Number(amount) || !note.trim()}
                    >
                      Review adjustment
                    </button>
                  </form>
                )}
              </>
            )}
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
