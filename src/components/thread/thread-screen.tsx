/*
 * ThreadScreen — the /c/[slug] conversation view.
 *
 * Business logic:
 * - opening a chat makes it the active context and loads its thread;
 *   only the active branch path renders, while all messages feed the
 *   per-parent sibling map behind each turn's BranchNav.
 * - a ?leaf=<messageId> query switches to that branch — how published
 *   artifacts and settings links return to their source chat/branch.
 * - the header carries the title, a branch-count badge, and a ⋯ menu
 *   that exports the branch on screen as .txt with thinking and tool
 *   steps interleaved inline.
 * - bottom-follow scrolling: pinned while the reader is at the bottom,
 *   unpinned by an upward scroll mid-stream, re-pinned on chat switch
 *   or when the total message count grows — the count spans all
 *   branches so flipping branches doesn't yank the view; a
 *   ResizeObserver follows markdown that grows after commit.
 * - while generating: a spinner telling the reader to stop from the
 *   composer, plus the queued messages listed in send order, each
 *   removable until it starts.
 * - a failed send surfaces as an ErrorCard at the thread's end.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams_UNSTABLE } from 'waku/router/client';
import { useRouter } from 'waku';
import { I } from '../../lib/icons';
import { Menu, Tip } from '../../lib/popover';
import { actions, useChatsStore, useThreadsStore } from '../../stores';
import { branchPath } from '../../stores/threads';
import { ErrorCard } from './error-card';
import { MessageBubble } from './message-bubble';

export function ThreadScreen() {
  const params = useParams_UNSTABLE({ from: '/c/[slug]' });
  const chatId = params?.slug ?? '';
  const router = useRouter();
  const thread = useThreadsStore((s) => s.threads[chatId]);
  const chat = useChatsStore(
    (s) => s.items.find((c) => c.id === chatId) ?? null,
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (chatId !== '') actions.setContext(chatId);
    void actions.loadThread(chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  /* a `?leaf=<messageId>` (e.g. a link from a published artifact) selects that branch */
  const leafParam = useMemo(
    () => new URLSearchParams(router.query).get('leaf'),
    [router.query],
  );
  useEffect(() => {
    if (!leafParam || !thread) return;
    const target = thread.messages.find((m) => m.id === leafParam);
    if (target) actions.switchBranch(chatId, leafParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafParam, thread?.messages.length, chatId]);

  const all = thread?.messages ?? [];
  const leafId = thread?.leafId ?? null;
  const messages = useMemo(() => branchPath(all, leafId), [all, leafId]);
  /* sibling ids by parent, oldest first; more than one means the turn has branches */
  const siblings = useMemo(() => {
    const out = new Map<string | null, string[]>();
    for (const m of all)
      out.set(m.parentId, [...(out.get(m.parentId) ?? []), m.id]);
    return out;
  }, [all]);
  const streaming = thread?.streaming === true;
  const error = thread?.error ?? null;

  /* follow the bottom only while the user is already there, so scrolling up mid-stream sticks */
  const pinned = useRef(true);
  /* counts every branch, so flipping between branches doesn't yank the view to the bottom */
  const count = all.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on chat switch or a new message
  useEffect(() => {
    pinned.current = true;
  }, [chatId, count]);

  const lastTop = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to bottom when content changes
  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  /* markdown blocks mount and highlight after the commit, so follow the content's size, not just renders */
  useEffect(() => {
    const el = listRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  return (
    <main
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        /* only an upward scroll unpins; content growing under a programmatic scroll must not */
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 32)
          pinned.current = true;
        else if (el.scrollTop < lastTop.current) pinned.current = false;
        lastTop.current = el.scrollTop;
      }}
      className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:px-6"
    >
      <div
        ref={contentRef}
        className="mx-auto flex w-full max-w-[640px] flex-col gap-3"
      >
        <div className="flex items-center gap-2 pb-1">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {chat?.title ?? (thread ? 'New chat' : 'Loading…')}
          </span>
          {chat && chat.branchCount >= 1 && (
            <span className="num flex shrink-0 items-center gap-1 text-[11px] muted">
              <I n="branch" s={11} /> {Math.max(1, chat.branchCount)}
            </span>
          )}
          {chat && (
            <Tip label="Chat actions" side="bottom">
              <button
                ref={menuAnchor}
                type="button"
                aria-label="Chat actions"
                aria-expanded={menu}
                onClick={() => setMenu((v) => !v)}
                className="ctl-icon size-6 shrink-0 border-transparent bg-transparent text-[var(--text-3)] hover:bg-[var(--sunken)] hover:text-[var(--text)]"
              >
                <I n="dots" s={14} />
              </button>
            </Tip>
          )}
        </div>
        <Menu
          open={menu}
          anchor={menuAnchor}
          onClose={() => setMenu(false)}
          items={[
            {
              label: 'Export as text',
              onSelect: () => actions.exportChat(chatId),
            },
          ]}
        />

        {messages.length === 0 && !error && (
          <div className="py-10 text-center text-[12px] muted">
            The thread is empty. Type below — the composer is the same surface
            you sent from.
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            m={m}
            chatId={chatId}
            siblings={siblings.get(m.parentId) ?? [m.id]}
            busy={streaming}
          />
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

        {(thread?.queue.length ?? 0) > 0 && (
          <div className="flex flex-col gap-0.5 py-0.5">
            {thread?.queue.map((q, i) => (
              <div
                key={q.id}
                className="flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--sunken)] px-2 py-1 text-[12px]"
              >
                <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-[var(--text-inv)]">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-2)]">
                  {q.content || '(attachment)'}
                </span>
                <Tip label="Cancel queued message" side="top">
                  <button
                    type="button"
                    aria-label="Cancel queued message"
                    onClick={() => actions.dequeueMessage(chatId, q.id)}
                    className="ctl-icon shrink-0 text-[var(--text-3)] hover:text-[var(--text)]"
                  >
                    <I n="x" s={10} />
                  </button>
                </Tip>
              </div>
            ))}
          </div>
        )}

        {error && <ErrorCard chatId={chatId} text={error.text} />}
      </div>
    </main>
  );
}
