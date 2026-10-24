/*
 * PrivateScreen — the /p unsaved-chat view.
 *
 * Business logic:
 * - sets the UI context to 'private' on mount and clears any pending folder,
 *   so the composer routes its sends to the transient store.
 * - renders the flat in-memory conversation from usePrivateStore; no server
 *   fetch, no chat row, no branching — turns are just user/assistant bubbles.
 * - bottom-follow scrolling mirrors the thread view: pinned while at the
 *   bottom, unpinned by an upward scroll mid-stream.
 * - a "private" badge in the header marks the chat as unsaved; the theme
 *   switch to the private accent is handled by the shell via data-private.
 */
'use client';

import { useEffect, useRef } from 'react';
import { I } from '../lib/icons';
import { actions, type PrivateMsg, usePrivateStore } from '../stores';
import { Markdown } from './markdown';

export function PrivateScreen() {
  const messages = usePrivateStore((s) => s.messages);
  const streaming = usePrivateStore((s) => s.streaming);
  const error = usePrivateStore((s) => s.error);

  const listRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);

  useEffect(() => {
    actions.setContext('private');
  }, []);

  const count = messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on a new message
  useEffect(() => {
    pinned.current = true;
  }, [count]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to bottom when content changes
  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const isEmpty = messages.length === 0;

  return (
    <main
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 32)
          pinned.current = true;
        else if (el.scrollTop < lastTop.current) pinned.current = false;
        lastTop.current = el.scrollTop;
      }}
      className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3">
        <div className="flex items-center gap-2 pb-1">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-semibold">
            <I n="lock" s={13} className="muted shrink-0" />
            Private chat
          </span>
          <span className="num flex shrink-0 items-center gap-1 rounded-sm border border-[var(--binding)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--binding)]">
            not saved
          </span>
        </div>

        {isEmpty && (
          <div className="py-10 text-center text-[12px] muted">
            This chat is private and temporary — nothing here is saved. Messages
            vanish when the page is reloaded.
          </div>
        )}

        {messages.map((m) => (
          <PrivateBubble key={m.id} m={m} />
        ))}

        {streaming && (
          <div
            className="flex items-center gap-2 py-1 text-[12px] muted"
            role="status"
          >
            <span className="block size-3 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-transparent" />
            generating — press stop in the composer
          </div>
        )}

        {error && !streaming && (
          <div className="flex items-center gap-2 rounded-md border border-[var(--danger)] bg-[var(--sunken)] px-2.5 py-2 text-[12px] text-[var(--danger)]">
            <I n="alert" s={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{error.text}</span>
            <button
              type="button"
              onClick={() => actions.retry()}
              className="ctl shrink-0"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

function PrivateBubble({ m }: { m: PrivateMsg }) {
  const isUser = m.role === 'user';
  const statusSuffix =
    m.status === 'sending'
      ? ' · sending'
      : m.status === 'failed'
        ? ' · failed'
        : m.status === 'stopped'
          ? ' · stopped'
          : m.status === 'error'
            ? ' · failed'
            : '';
  return (
    <article
      className={`group/msg flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}
    >
      <div className="sec-label">
        {isUser && 'you'}
        {!isUser && 'assistant'}
        {statusSuffix}
      </div>
      <div
        className={`rounded-lg border px-3 py-2 text-[13px] leading-[1.55] ${
          isUser
            ? 'max-w-[92%] border-(--border-strong) bg-muted'
            : 'w-full border-[var(--border)] bg-[var(--raised)]'
        }`}
      >
        {m.content ? (
          <Markdown text={m.content} live={m.status === 'streaming'} />
        ) : (
          <span className="muted">…</span>
        )}
        {m.error && (
          <div className="num mt-1.5 text-[11px] text-(--danger)">
            {m.error}
          </div>
        )}
      </div>
    </article>
  );
}
