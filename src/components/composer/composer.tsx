/*
 * Composer — the single message input surface, shared by home and
 * every thread.
 *
 * Business logic:
 * - home (context 'new') edits the persisted draft store; a thread
 *   edits its own draft kept on the thread entry, so per-chat drafts
 *   survive switching chats. Draft-restored and long-paste notices are
 *   home-only.
 * - sending is blocked while text and attachments are both empty, or
 *   when the context estimate overflows the model's window; the reason
 *   shows in the footer and to screen readers.
 * - home sends via beginSend, which mints the chat id client-side and
 *   navigates before the server answers; a thread sends via sendReply,
 *   which queues the turn while a reply is streaming and drains the
 *   queue in order once the run settles.
 * - Enter sends per the enterToSend pref (an account setting, see
 *   stores/prefs), ⌘/Ctrl+Enter always sends, Shift+Enter inserts a
 *   newline, Escape blurs.
 * - pasted or picked files upload through attachFiles into the tray; a
 *   storage failure keeps the metadata so the composer isn't blocked.
 * - the textarea auto-grows to 40% of the viewport, then scrolls
 *   inside; it is read-only while a first send is in flight.
 * - the textarea is exposed via setComposerEl so store actions can
 *   focus it or insert suggestion text.
 */
'use client';

import { useEffect, useRef } from 'react';
import { attachFiles } from '../../lib/attachments';
import {
  actions,
  setComposerEl,
  useDraftStore,
  useEstimate,
  usePrefsStore,
  usePrivateStore,
  useThreadsStore,
  useUIStore,
} from '../../stores';
import { branchPath } from '../../stores/threads';
import { AttachmentTray } from './attachment-tray';
import { ComposerFooter } from './composer-footer';
import { DraftNotice, LongPasteBar, NoToolsNote } from './composer-notices';
import { ToolBar } from './tool-bar';

const MIN_HEIGHT = 36;

export function Composer() {
  const context = useUIStore((s) => s.context);
  const onHome = context === 'new';
  const onPrivate = context === 'private';
  const homeText = useDraftStore((s) => s.text);
  const threadText = useThreadsStore((s) => s.threads[context]?.draft ?? '');
  const privateText = usePrivateStore((s) => s.draft);
  const draftText = onHome ? homeText : onPrivate ? privateText : threadText;
  const attachments = useDraftStore((s) => s.attachments);
  const sending = useUIStore((s) => s.sending);
  const streaming = useThreadsStore(
    (s) => s.threads[context]?.streaming === true,
  );
  const privateStreaming = usePrivateStore((s) => s.streaming);
  const queueCount = useThreadsStore(
    (s) => s.threads[context]?.queue.length ?? 0,
  );
  const draftNotice = useUIStore((s) => onHome && s.draftNotice);
  const longPaste = useUIStore((s) => onHome && s.longPaste);
  const noToolsNote = useUIStore((s) => s.noToolsNote);
  const est = useEstimate((e) => ({
    tokens: e.tokens,
    cost: e.cost,
    overflow: e.overflow,
    hasAttachments: e.hasAttachments,
  }));
  const actualCost = useThreadsStore((s) => {
    if (context === 'new') return null;
    const t = s.threads[context];
    if (!t) return null;
    /* the last completed reply on the visible branch: a regenerated or retried
       reply streams as a new sibling with no usage yet, so its predecessor's
       cost falls off the branch and the footer resets to the ~estimate instead
       of lingering on the reply that was replaced */
    const last = branchPath(t.messages, t.leafId).findLast(
      (m) => m.role === 'assistant' && m.usage,
    );
    return last?.usage?.costUsd ?? null;
  });
  const enterToSend = usePrefsStore((s) => s.enterToSend);
  const spellcheck = usePrefsStore((s) => s.spellcheck);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setComposerEl(taRef.current);
    return () => setComposerEl(null);
  }, []);

  /* auto-grow, capped at 40vh */
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = `${Math.max(MIN_HEIGHT, Math.min(el.scrollHeight, max))}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draftText]);

  const canSend = draftText.trim() !== '' || attachments.length > 0;
  const blockedReason = est.overflow
    ? 'Context overflow — remove content or switch to a larger model'
    : !canSend
      ? 'Write a message or attach a file first'
      : null;

  const doSend = () => {
    if (blockedReason) return;
    if (onPrivate) actions.privateSend();
    else if (onHome) actions.beginSend();
    else actions.sendReply(useUIStore.getState().context);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && (mod || (!e.shiftKey && enterToSend))) {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === 'Escape') taRef.current?.blur();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (onPrivate) return;
    const files = [...e.clipboardData.items]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) {
      e.preventDefault();
      void attachFiles(files).then(actions.addAttachments);
    }
  };

  const onFiles = (files: FileList | null) => {
    if (!files || onPrivate) return;
    void attachFiles([...files]).then(actions.addAttachments);
  };

  return (
    <div className="mx-auto w-full max-w-[var(--stage-max)]">
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {draftNotice && <DraftNotice />}

      <div
        className="relative z-20 rounded-xl border border-[var(--border-strong)] bg-[var(--raised)]"
        data-composer=""
      >
        {!onPrivate && <ToolBar />}
        {!onPrivate && <AttachmentTray attachments={attachments} />}

        <textarea
          ref={taRef}
          value={draftText}
          onChange={(e) =>
            onPrivate
              ? actions.privateSetText(e.target.value)
              : onHome
                ? actions.setText(e.target.value)
                : actions.setThreadText(
                    useUIStore.getState().context,
                    e.target.value,
                  )
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          readOnly={sending}
          spellCheck={spellcheck}
          rows={1}
          aria-label="Message"
          aria-describedby="composer-hint"
          placeholder="Message…"
          className="block w-full resize-none bg-transparent px-3 py-2 text-[14px] leading-[1.5] outline-none focus-visible:shadow-none placeholder:text-[var(--text-3)]"
          style={{ minHeight: MIN_HEIGHT }}
        />

        {longPaste && <LongPasteBar />}

        <ComposerFooter
          empty={draftText === '' && attachments.length === 0}
          tokens={est.tokens}
          cost={est.cost}
          actualCost={actualCost}
          streaming={onPrivate ? privateStreaming : streaming}
          sending={sending}
          blockedReason={blockedReason}
          queueCount={queueCount}
          onAttach={() => fileRef.current?.click()}
          onSend={doSend}
        />
      </div>

      {noToolsNote && <NoToolsNote />}
    </div>
  );
}
