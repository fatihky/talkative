/*
 * SystemPromptDialog — editor for a chat's or a folder's system prompt.
 *
 * Business logic:
 * - One dialog serves both targets, picked by ui.systemPromptFor; it
 *   renders nothing until a target and its chat/folder row both exist.
 * - The editor is keyed by target, so reopening it for another chat or
 *   folder starts from that one's stored prompt, not the previous draft.
 * - Folder prompts are inherited: the dialog lists the ones this target
 *   picks up, outermost folder first — the same order the server
 *   concatenates them in before the chat's own.
 * - A folder prompt applies to every chat inside it and its subfolders; a
 *   chat prompt applies from its next reply on.
 * - Length is capped at 20,000 chars, mirroring SYSTEM_PROMPT_MAX in
 *   server/chats.ts so the client can't offer what the server rejects.
 * - Saving writes optimistically through the chats/folders store (which
 *   rolls back and toasts on failure); mod+Enter saves, Esc or a scrim
 *   click discards without writing. The save button and an "Unsaved
 *   changes" label only light up once the text differs from the saved
 *   prompt, so it is always clear whether an edit was stored.
 * - Clearing the text removes the prompt (stored as null), which is what
 *   the helper copy promises.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { I } from '../lib/icons';
import { actions, useChatsStore, useFoldersStore, useUIStore } from '../stores';
import type { Folder } from '../types';
import { Kbd } from '../ui/primitives';

/* mirrors SYSTEM_PROMPT_MAX in server/chats.ts */
const MAX = 20_000;

/* prompts the target inherits, outermost folder first — the order the server sends them in */
const inheritedFrom = (folders: Folder[], folderId: string | null) => {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: { name: string; text: string }[] = [];
  for (
    let f = folderId ? byId.get(folderId) : undefined, n = 0;
    f && n <= folders.length;
    f = f.parentId ? byId.get(f.parentId) : undefined, n++
  )
    if (f.systemPrompt) out.unshift({ name: f.name, text: f.systemPrompt });
  return out;
};

export function SystemPromptDialog() {
  const target = useUIStore((s) => s.systemPromptFor);
  const chat = useChatsStore((s) =>
    target?.kind === 'chat' ? s.items.find((c) => c.id === target.id) : null,
  );
  const folders = useFoldersStore((s) => s.items);
  const folder =
    target?.kind === 'folder' ? folders.find((f) => f.id === target.id) : null;
  const item = chat ?? folder;
  if (!target || !item) return null;
  /* keyed so reopening for another target starts from that target's text */
  return (
    <Editor
      key={`${target.kind}:${target.id}`}
      kind={target.kind}
      name={chat ? chat.title : (folder?.name ?? '')}
      initial={item.systemPrompt ?? ''}
      inherited={inheritedFrom(
        folders,
        chat ? (chat.folderId ?? null) : (folder?.parentId ?? null),
      )}
      onSave={(text) =>
        target.kind === 'chat'
          ? actions.setChatSystemPrompt(target.id, text)
          : actions.setFolderSystemPrompt(target.id, text)
      }
    />
  );
}

function Editor({
  kind,
  name,
  initial,
  inherited,
  onSave,
}: {
  kind: 'chat' | 'folder';
  name: string;
  initial: string;
  inherited: { name: string; text: string }[];
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const mod = useUIStore((s) => s.mod);
  const close = () => actions.editSystemPrompt(null);
  const save = () => {
    void onSave(text);
    close();
  };

  useEffect(() => {
    const el = area.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const dirty = text !== initial;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="pop mt-[12vh] flex max-h-[76vh] w-full max-w-[600px] flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={`System prompt for ${kind} ${name}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <I
            n={kind === 'folder' ? 'folder' : 'settings'}
            s={13}
            className="muted shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-[500]">
            System prompt · {name}
          </span>
          <Kbd>esc</Kbd>
        </div>
        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          {inherited.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer select-none text-[var(--text-2)]">
                Inherits from {inherited.map((p) => p.name).join(' / ')}
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                {inherited.map((p) => (
                  <div
                    key={p.name + p.text.length}
                    className="rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] p-2"
                  >
                    <div className="mb-1 text-[11px] muted">{p.name}</div>
                    <div className="max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.5] text-[var(--text-2)]">
                      {p.text}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
          <textarea
            ref={area}
            value={text}
            maxLength={MAX}
            rows={12}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              kind === 'folder'
                ? 'Instructions for every chat in this folder and its subfolders…'
                : 'Instructions for this chat…'
            }
            aria-label="System prompt"
            className={`w-full resize-y rounded-[6px] border bg-[var(--panel)] p-3 text-[13px] leading-[1.6] outline-none placeholder:text-[var(--text-3)] ${
              dirty
                ? 'border-[var(--accent)]'
                : 'border-[var(--border)] focus:border-[var(--accent)]'
            }`}
          />
          <p className="text-[11px] leading-snug muted">
            {kind === 'folder'
              ? 'Sent before the chat’s own prompt, after any parent folder’s.'
              : 'Sent after any folder prompts. Applies from the next reply on.'}{' '}
            Leave empty to remove.
          </p>
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-2">
          <span
            className={`text-[11px] ${dirty ? 'text-[var(--accent)]' : 'muted'}`}
            aria-live="polite"
          >
            {dirty
              ? 'Unsaved changes'
              : initial.trim()
                ? 'Saved'
                : 'No prompt yet'}
          </span>
          <button
            type="button"
            onClick={close}
            className="ctl-ghost ml-auto h-7 rounded-[6px] px-2 text-[12px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty}
            className="ctl-primary flex h-7 items-center gap-1.5 rounded-[6px] px-3 text-[12px] disabled:opacity-40"
          >
            {initial.trim() ? 'Update' : 'Save'}
            <span className="text-[11px] opacity-70">{mod}↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
