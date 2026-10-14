/*
 * MemorySettings — list, add and clear the user's durable memories, plus
 * the MemoryForm used to create and edit one.
 *
 * Business logic:
 * - Memories are per user and shared across all chats; the model writes
 *   them mid-run through the memory tool, so the list always refetches on
 *   mount instead of trusting a local cache (the empty state says as much
 *   and points at granting the tool).
 * - Rows are newest edit first and link to the memory's own page rather
 *   than editing inline; the count and reload button live in the header.
 * - The filter box appears only past five memories and matches key or
 *   value case-insensitively, with a "no match" line when it finds none.
 * - "Forget all" is gated by a native window.confirm and clears every
 *   memory; failures surface via window.alert instead of the app's
 *   confirm dialog or toasts.
 * - MemoryForm creates when `initial` is null and updates otherwise; key
 *   (max 255, unique per user) and value are both required, submit is
 *   disabled while saving, and an error keeps the form open with the
 *   message inline.
 */
'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'waku/router/client';
import { timeAgo } from '../lib/format';
import { I } from '../lib/icons';
import { actions, useMemoriesStore } from '../stores';
import { errorText } from '../stores/models';
import type { Memory } from '../types';
import { IconButton } from '../ui/primitives';

const inputCls =
  'w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]';

export function MemorySettings() {
  const { items, status, error } = useMemoriesStore();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void actions.loadMemories();
  }, []);

  const clear = async () => {
    if (!window.confirm(`Forget all ${items.length} memories?`)) return;
    try {
      await actions.clearMemories();
    } catch (e) {
      window.alert(errorText(e));
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = q
    ? items.filter(
        (m) =>
          m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q),
      )
    : items;

  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="sec-label">Memory</div>
        {status === 'ready' && items.length > 0 && (
          <span className="num text-[11px] muted">{items.length}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon="retry"
            tip="Reload"
            ghost
            size={24}
            disabled={status === 'loading'}
            onClick={() => void actions.loadMemories()}
          />
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => void clear()}
              className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px] text-[var(--danger)]"
            >
              Forget all
            </button>
          )}
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="ctl h-7 rounded-[6px] px-2 text-[12px]"
            >
              Add memory
            </button>
          )}
        </div>
      </div>

      {status === 'error' && (
        <div className="mb-2 text-[12px] text-[var(--danger)]">{error}</div>
      )}
      {status === 'ready' && items.length === 0 && !adding && (
        <div className="text-[12px] muted">
          Nothing remembered yet. Grant the memory tool and the model saves
          durable facts here, shared across all chats.
        </div>
      )}

      {adding && <MemoryForm initial={null} onDone={() => setAdding(false)} />}

      {items.length > 5 && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter memories…"
          aria-label="Filter memories"
          className={`mb-2 h-8 ${inputCls}`}
        />
      )}

      <div className="-mx-1 flex flex-col">
        {shown.map((m) => (
          <div
            key={m.id}
            className="group flex items-center gap-1 rounded-[6px] hover:bg-[var(--sunken)]"
          >
            <Link
              to={`/settings/memories/${m.id}`}
              className="flex min-w-0 flex-1 items-center gap-2 p-2 text-[13px]"
            >
              <span className="num min-w-0 flex-1 truncate">{m.key}</span>
              <span className="num shrink-0 text-[11px] muted">
                {timeAgo(m.updatedAt)}
              </span>
            </Link>
            <button
              type="button"
              className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              aria-label={`Attach memory ${m.key} to next message`}
              onClick={() => actions.attachMemory(m.id)}
            >
              <I n="paperclip" s={12} />
            </button>
          </div>
        ))}
        {q && shown.length === 0 && (
          <div className="text-[12px] muted">No memories match “{filter}”.</div>
        )}
      </div>
    </section>
  );
}

export function MemoryForm({
  initial,
  onDone,
}: {
  initial: Memory | null;
  onDone: () => void;
}) {
  const [key, setKey] = useState(initial?.key ?? '');
  const [value, setValue] = useState(initial?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (initial) await actions.updateMemory(initial.id, { key, value });
      else await actions.createMemory({ key, value });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="my-2 flex flex-col gap-2 rounded-[6px] border border-[var(--border)] p-3"
    >
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="muted">Key</span>
        <input
          required
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="preferred-language"
          maxLength={255}
          className={`num h-8 ${inputCls}`}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="muted">Value</span>
        <textarea
          required
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Prefers TypeScript examples over JavaScript"
          className={`resize-y py-1.5 ${inputCls}`}
        />
      </label>
      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="ctl-primary h-7 rounded-[6px] px-3 text-[12px]"
        >
          {busy ? 'Saving…' : initial ? 'Save' : 'Add memory'}
        </button>
      </div>
    </form>
  );
}
