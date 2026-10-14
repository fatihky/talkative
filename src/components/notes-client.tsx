/*
 * NotesClient / NoteEditor — the notes list and its single-note editor.
 *
 * Business logic:
 * - Notes are the user's own, listed newest first; "New note" creates one
 *   optimistically with a client-minted id and routes into its editor
 *   before the server has answered.
 * - The empty state distinguishes loading, a failed load and really no
 *   notes, so a broken fetch isn't presented as an empty account.
 * - The editor sets the UI context to 'new' so the always-on composer
 *   keeps targeting the home draft while a note is open.
 * - Leaving the editor flushes that note's pending debounced save, so the
 *   last keystrokes reach the server instead of dying with the timer.
 * - Title and body edits go through one debounced patch; a blanked title
 *   is never sent, keeping the last good one (the server rejects blanks).
 * - Attach puts the note on the composer draft as a `note:` attachment —
 *   its text is inlined into the prompt when a message is actually sent,
 *   so later edits change what the model sees.
 * - Delete needs a confirmation that warns attached chats lose the text,
 *   then returns to /notes.
 */
'use client';

import { useEffect } from 'react';
import { Link, useParams_UNSTABLE } from 'waku/router/client';
import { timeAgo } from '../lib/format';
import { I } from '../lib/icons';
import { actions, useNotesStore } from '../stores';
import { Page } from './page';

export function NotesClient() {
  const notes = useNotesStore((s) => s.notes);
  const status = useNotesStore((s) => s.status);
  return (
    <Page title="Notes">
      <div className="flex flex-col gap-2">
        <div className="flex justify-end">
          <button
            type="button"
            className="ctl-primary h-7"
            onClick={() => actions.createNote()}
          >
            <I n="plus" s={13} /> New note
          </button>
        </div>
        {notes.length === 0 && (
          <div className="py-10 text-center text-[12px] muted">
            {status === 'loading'
              ? 'Loading notes…'
              : status === 'error'
                ? 'Couldn’t load notes.'
                : 'No notes yet.'}
          </div>
        )}
        <div className="flex flex-col">
          {notes.map((n) => (
            <Link
              key={n.id}
              to={`/notes/${n.id}`}
              className="flex items-center gap-2 rounded-[6px] px-2.5 py-2 hover:bg-[var(--sunken)]"
            >
              <I n="note" s={13} className="shrink-0 text-[var(--text-3)]" />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {n.title || 'Untitled note'}
              </span>
              <span className="num shrink-0 text-[11px] muted">
                {timeAgo(n.createdAt)}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </Page>
  );
}

export function NoteEditor() {
  const params = useParams_UNSTABLE({ from: '/notes/[slug]' });
  const id = params?.slug ?? '';
  const note = useNotesStore((s) => s.notes.find((n) => n.id === id) ?? null);
  const status = useNotesStore((s) => s.status);
  const saveStatus = useNotesStore((s) => s.saveStatus[id]);

  useEffect(() => {
    actions.setContext('new');
    /* don't leave the last keystrokes waiting on the debounce */
    return () => actions.flushNote(id);
  }, [id]);

  return (
    <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3">
        <div className="flex items-center gap-2">
          <Link
            to="/notes"
            className="ctl-icon border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
            aria-label="Back to notes"
          >
            <I n="arrow-left" s={14} />
          </Link>
          {note ? (
            <>
              <input
                value={note.title}
                aria-label="Note title"
                placeholder="Untitled note"
                onChange={(e) =>
                  actions.editNote(note.id, note.text, e.target.value)
                }
                className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold outline-none placeholder:text-[var(--text-3)]"
              />
              <span className="num shrink-0 text-[11px] muted">
                {timeAgo(note.createdAt)}
              </span>
              <button
                type="button"
                className="ctl h-7 px-2 text-[11px]"
                onClick={() => actions.attachNote(note.id)}
              >
                <I n="paperclip" s={12} /> Attach
              </button>
              <button
                type="button"
                className="ctl-icon"
                aria-label="Delete note"
                onClick={async () => {
                  const ok = await actions.confirm({
                    title: `Delete “${note.title || 'Untitled note'}”?`,
                    body: 'Chats it was attached to will no longer see its text. This can’t be undone.',
                    confirmLabel: 'Delete',
                    danger: true,
                  });
                  if (!ok) return;
                  actions.deleteNote(note.id);
                  actions.navigateTo('/notes');
                }}
              >
                <I n="trash" s={13} />
              </button>
            </>
          ) : (
            <span className="text-[13px] muted">
              {status === 'loading' ? 'Loading…' : 'Note not found'}
            </span>
          )}
        </div>
        {note && (
          <textarea
            value={note.text}
            aria-label={`Note body ${note.title}`}
            placeholder="Write something…"
            rows={16}
            onChange={(e) => actions.editNote(note.id, e.target.value)}
            className="w-full resize-y rounded-[6px] border border-[var(--border)] bg-[var(--panel)] p-3 text-[13px] leading-[1.6] outline-none placeholder:text-[var(--text-3)]"
          />
        )}
        {note && saveStatus && (
          <div className="text-right text-[11px] muted" aria-live="polite">
            {saveStatus === 'saving' ? 'Saving…' : 'Saved'}
          </div>
        )}
      </div>
    </main>
  );
}
