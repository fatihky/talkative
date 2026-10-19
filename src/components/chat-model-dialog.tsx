/*
 * ChatModelDialog — picks the model an existing chat continues with.
 *
 * Business logic:
 * - The composer picker doubles as the new-chat default, so changing one
 *   chat's model from the sidebar or the thread header would move that
 *   default underneath the next chat. This dialog is the other door: it
 *   only writes the open chat's own model (and the thinking level, to what
 *   that model supports), leaving 'home.lastModel' and every other chat
 *   alone.
 * - Saves as soon as a model is picked; the next turn the chat sends —
 *   including a regenerate — goes to it, and the stored chat row follows
 *   from that turn, so reopening the chat comes back with it.
 * - When the chat's last send failed and the thread isn't loaded (a reload
 *   on that chat), the composer shows no model to change: the dialog offers
 *   to retry the failed message, since a retry goes out with the chat's
 *   stored model.
 * - Only chat-capable models are listed, grouped by provider; a search
 *   matches name, id, provider and capability keywords like the composer
 *   picker. The chat's current model starts highlighted and can be a stale
 *   entry (no key any more), so the list resolves it from the catalog when
 *   it is there.
 * - Mounted once in the shell, opened by ui.chatModelPicker.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { ctxFmt } from '../lib/format';
import { I } from '../lib/icons';
import { isChattable, modelSearchText } from '../lib/models';
import {
  actions,
  useChatsStore,
  useModelsStore,
  useThreadsStore,
  useUIStore,
} from '../stores';
import { branchPath } from '../stores/threads';
import type { Model } from '../types';
import { Modal } from '../ui/modal';

/** the model a chat's next turn would use: its newest branch turn, else the chat row */
const chatModelId = (chatId: string): string => {
  const t = useThreadsStore.getState().threads[chatId];
  if (t) {
    let id: string | undefined;
    const path = branchPath(t.messages, t.leafId);
    for (let i = path.length - 1; i >= 0 && !id; i--) id = path[i]?.modelId;
    if (id) return id;
  }
  return (
    useChatsStore.getState().items.find((c) => c.id === chatId)?.modelId ?? ''
  );
};

/** answers ui.chatModelPicker; mounted once in the shell */
export function ChatModelDialog() {
  const chatId = useUIStore((s) => s.chatModelPicker);
  if (!chatId) return null;
  /* keyed by the chat, so a second picker always starts from that chat's own model */
  return <Picker chatId={chatId} key={chatId} />;
}

function Picker({ chatId }: { chatId: string }) {
  const items = useModelsStore((s) => s.items);
  const title = useChatsStore(
    (s) => s.items.find((c) => c.id === chatId)?.title ?? null,
  );
  /* the thread loads a moment after the chat opens, so the retry offer is tracked live */
  const chatModel = useThreadsStore((s) => chatModelId(chatId));
  const retryable = useThreadsStore(
    (s) => s.threads[chatId]?.error !== undefined,
  );
  const [selected, setSelected] = useState(chatModel);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const close = () => actions.closeChatModelPicker();
  const pick = (id: string) => {
    /* a chat another tab deleted has nothing to switch */
    if (useChatsStore.getState().items.some((c) => c.id === chatId))
      actions.switchChatModel(id);
    close();
  };

  const q = query.trim().toLowerCase();
  const chattable = items.filter(isChattable);
  const shown = q
    ? chattable.filter((m) => modelSearchText(m).toLowerCase().includes(q))
    : chattable;
  /* keep the provider grouping of the composer picker unless a query flattens it */
  const groups: { provider: string; models: Model[] }[] = [];
  if (q) groups.push({ provider: '', models: shown });
  else {
    const byProvider = new Map<string, Model[]>();
    for (const m of shown) {
      const bucket = byProvider.get(m.provider) ?? [];
      bucket.push(m);
      byProvider.set(m.provider, bucket);
    }
    for (const [provider, models] of byProvider) groups.push({ provider, models });
  }

  return (
    <Modal
      title={title ? `Model for “${title}”` : 'Model for this chat'}
      icon="brain"
      onClose={close}
      width={460}
      footer={
        <button
          type="button"
          onClick={close}
          className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px]"
        >
          Cancel
        </button>
      }
    >
      {retryable && (
        <div className="mb-2 rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 py-1.5 text-[12px]">
          This chat’s last message didn’t go through, so the composer has no
          model to change.{' '}
          <button
            type="button"
            onClick={() => {
              actions.retrySend(chatId);
              close();
            }}
            className="text-[var(--accent)] hover:underline"
          >
            Retry it
          </button>{' '}
          — it is sent with the chat’s model, {chatModel}.
        </div>
      )}

      <div className="model-menu-search mb-2">
        <I n="search" s={14} />
        <input
          ref={input}
          type="text"
          aria-label="Search models"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const first = shown[0];
              if (first) pick(first.id);
            }
          }}
        />
      </div>

      <div role="listbox" aria-label="Models" className="-mx-1">
        {shown.length === 0 ? (
          <div className="px-2 py-4 text-[12px] muted">
            {chattable.length === 0 ? 'No models loaded.' : 'No matching models.'}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.provider || 'all'}>
              {g.provider && <div className="model-menu-group">{g.provider}</div>}
              {g.models.map((m) => {
                const sel = m.id === selected;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={sel}
                    onClick={() => {
                      setSelected(m.id);
                      pick(m.id);
                    }}
                    className={`model-menu-item ${sel ? 'on' : ''} ${
                      m.status !== 'ok' ? 'off' : ''
                    }`}
                  >
                    <span className="mm-dot" aria-hidden="true" />
                    <span className="mm-main">
                      <span className="mm-name">
                        {m.shortName}
                        {m.status === 'error' && (
                          <span className="ml-1.5 font-sans text-[10px] text-[var(--danger)]">
                            no key
                          </span>
                        )}
                        {m.status === 'stale' && (
                          <span className="ml-1.5 font-sans text-[10px] text-[var(--warn)]">
                            stale
                          </span>
                        )}
                      </span>
                      <span className="mm-provider">
                        {m.provider}
                        {m.params ? ` · ${m.params}` : ''}
                        {m.context.window != null
                          ? ` · ${ctxFmt(m.context.window)} ctx`
                          : ''}
                        {' · '}${m.pricing.input}/${m.pricing.output} per M
                      </span>
                    </span>
                    <I n="check" s={13} className="mm-check shrink-0" />
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <p className="mt-2 px-1 text-[11px] muted">
        Applies to this chat only. New chats keep the default model picked on
        the home screen.
      </p>
    </Modal>
  );
}
