import { useState, type FormEvent } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { useHousehold } from '../store';
import { Empty } from './ui';

export function QuickList({ full = false, initialList }: { full?: boolean; initialList?: string }) {
  const { lists, addItem, toggleItem, removeItem } = useHousehold();
  const [selected, setSelected] = useState(initialList ?? lists[0]?.id);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(full);
  const list = lists.find((l) => l.id === selected) ?? lists[0];
  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() && list) {
      addItem(list.id, text);
      setText('');
    }
  }
  if (!list) return <Empty>Create your first shared list.</Empty>;
  return (
    <>
      <div className="list-tabs" role="group" aria-label="Shared lists">
        {lists.map((l) => (
          <button
            key={l.id}
            className={l.id === list.id ? 'active' : ''}
            aria-pressed={l.id === list.id}
            onClick={() => setSelected(l.id)}
          >
            {l.name}
            {full && <span>{l.items.filter((i) => !i.completed).length}</span>}
          </button>
        ))}
      </div>
      <div className={`list-items ${full ? 'full-list' : ''}`}>
        {list.items.length === 0 && <Empty>A fresh list. Add something below.</Empty>}
        {list.items.map((item) => (
          <div className="list-item" key={item.id}>
            <label className={item.completed ? 'completed' : ''}>
              <input
                type="checkbox"
                checked={item.completed}
                onChange={() => toggleItem(list.id, item.id)}
              />
              <span className="check-visual">
                <Check size={15} />
              </span>
              <span>{item.text}</span>
            </label>
            {full && (
              <button
                className="icon-button delete-button"
                aria-label={`Remove ${item.text}`}
                onClick={() => removeItem(list.id, item.id)}
              >
                <Trash2 size={17} />
              </button>
            )}
          </div>
        ))}
      </div>
      {adding ? (
        <form className="inline-add" onSubmit={submit}>
          <input
            aria-label="New list item"
            placeholder="What do we need?"
            maxLength={120}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus={!full}
            required
          />
          <button className="primary icon-button" aria-label="Add item" type="submit">
            <Plus size={21} />
          </button>
        </form>
      ) : (
        <button className="soft-button full-width" onClick={() => setAdding(true)}>
          <Plus size={18} />
          Add item
        </button>
      )}
      {full && (
        <p className="list-summary">
          {list.items.filter((i) => i.completed).length} of {list.items.length} checked off · Shared
          with everyone
        </p>
      )}
    </>
  );
}
