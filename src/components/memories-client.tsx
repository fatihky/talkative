/*
 * MemoriesClient / MemoryDetailClient — the memories settings list page
 * and a single memory's page.
 *
 * Business logic:
 * - The list page is chrome only: a back header plus the shared
 *   MemorySettings section, so both routes work off the same store.
 * - The detail page reloads memories on mount because deep links arrive
 *   with an empty store, then picks the row out of it by route id.
 * - Until that load lands it shows "Loading…"; a ready store without the
 *   id shows "Memory not found." rather than an error.
 * - Edit swaps in MemoryForm prefilled with the memory and returns to the
 *   read view once it saves.
 * - Forget asks with a native window.confirm, deletes the memory (they're
 *   shared across every chat) and navigates back to the list; a failure
 *   is reported with window.alert.
 * - Created/updated are shown as a locale timestamp plus a relative one.
 */
'use client';

import { useEffect, useState } from 'react';
import { useParams_UNSTABLE } from 'waku/router/client';
import { timeAgo } from '../lib/format';
import { actions, useMemoriesStore } from '../stores';
import { errorText } from '../stores/models';
import { MemoryForm, MemorySettings } from './memory-settings';
import { SettingsHeader } from './settings-client';

export function MemoriesClient() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader title="Memories" back="/settings" />
      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
          <MemorySettings />
        </div>
      </main>
    </div>
  );
}

const stamp = (ts: number) =>
  `${new Date(ts).toLocaleString()} · ${timeAgo(ts)}`;

export function MemoryDetailClient() {
  const params = useParams_UNSTABLE({ from: '/settings/memories/[id]' });
  const id = params?.id ?? '';
  const memory = useMemoriesStore(
    (s) => s.items.find((m) => m.id === id) ?? null,
  );
  const status = useMemoriesStore((s) => s.status);
  const [editing, setEditing] = useState(false);

  /* deep links land here with an empty store */
  useEffect(() => {
    void actions.loadMemories();
  }, []);

  const remove = async () => {
    if (!memory || !window.confirm(`Forget "${memory.key}"?`)) return;
    try {
      await actions.deleteMemory(memory.id);
      actions.navigateTo('/settings/memories');
    } catch (e) {
      window.alert(errorText(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title={memory?.key ?? 'Memory'}
        back="/settings/memories"
      />
      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
          {!memory ? (
            <div className="py-10 text-center text-[12px] muted">
              {status === 'ready' ? 'Memory not found.' : 'Loading…'}
            </div>
          ) : editing ? (
            <MemoryForm initial={memory} onDone={() => setEditing(false)} />
          ) : (
            <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="num min-w-0 flex-1 truncate text-[14px] font-semibold">
                  {memory.key}
                </span>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="ctl h-7 rounded-[6px] px-2 text-[12px]"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove()}
                  className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px] text-[var(--danger)]"
                >
                  Forget
                </button>
              </div>
              <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.6]">
                {memory.value}
              </div>
              <div className="mt-3 flex flex-col gap-0.5 border-t border-[var(--border)] pt-2 text-[11px] muted">
                <span className="num">Updated {stamp(memory.updatedAt)}</span>
                <span className="num">Created {stamp(memory.createdAt)}</span>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
