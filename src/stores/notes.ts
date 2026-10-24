/*
 * NotesStore — the notes list, its editor sync, and attaching a note to
 * the composer.
 *
 * Business logic:
 * - notes are server-owned; setNoteItems is the only writer, keeps them
 *   newest-first by createdAt and mirrors to localStorage 'cache.notes'
 *   so boot can show them before GET /api/notes answers (cached entries
 *   without a numeric createdAt are dropped as pre-server leftovers).
 * - createNote is optimistic with a client-minted uuid and navigates
 *   straight to /notes/<id>, so the editor opens immediately; a failed
 *   POST takes the note back out of the list and toasts.
 * - editNote patches the store per keystroke and queues one debounced
 *   PATCH per note (1500ms) that merges the pending title and text;
 *   flushNote sends it at once, e.g. when the editor unmounts.
 * - a save waits on its note's in-flight create (the `creating` map) so
 *   the first keystrokes can't PATCH a row that doesn't exist yet, and
 *   skips the PATCH when that create failed — the note is already gone
 *   and has been toasted about.
 * - blank titles are never sent: the server rejects them, so the last
 *   good one stays until the field has text again.
 * - deleteNote removes locally first, cancels any pending patch, then
 *   DELETEs; on failure the previous list is restored and toasted.
 * - attachNote adds a 'note' attachment carrying the noteId instead of
 *   copying text, so the send reads whatever the note says by then.
 */
'use client';

import { create } from 'zustand';
import { notesApi } from '../lib/api';
import { LS, uid, uuid } from '../lib/storage';
import type { Note } from '../types';
import { draftActions } from './draft';
import { uiActions } from './ui';

type NotesState = {
  notes: Note[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** per-note save activity, surfaced as a subtle "Saving…"/"Saved" line at the bottom of the editor */
  saveStatus: Record<string, 'saving' | 'saved'>;
};

export const useNotesStore = create<NotesState>()(() => ({
  notes: [],
  status: 'idle',
  saveStatus: {},
}));

const set = useNotesStore.setState;
const get = useNotesStore.getState;
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'error');
const SAVE_DELAY_MS = 1500;

export const setNoteItems = (items: Note[]) => {
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  set({ notes: sorted });
  LS.set('cache.notes', sorted);
};

/* in-flight creates, so edits typed right after "new note" don't PATCH a row that doesn't exist yet */
const creating = new Map<string, Promise<unknown>>();
/* debounced saves per note; keystrokes merge into one pending patch */
const pending = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    patch: { title?: string; text?: string };
  }
>();
/* timers that clear a note's "Saved" flag once it has lingered long enough */
const savedTimers = new Map<string, ReturnType<typeof setTimeout>>();

const SAVED_FADE_MS = 2000;

const clearSaved = (id: string) => {
  const t = savedTimers.get(id);
  if (t) clearTimeout(t);
  savedTimers.delete(id);
  set((s) => {
    const { [id]: _dropped, ...rest } = s.saveStatus;
    return { saveStatus: rest };
  });
};

const save = (id: string) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  set((s) => ({ saveStatus: { ...s.saveStatus, [id]: 'saving' } }));
  void (creating.get(id) ?? Promise.resolve())
    /* a failed create already toasted and dropped the note */
    .then(
      () => notesApi.patch(id, p.patch),
      () => undefined,
    )
    .then(() => {
      set((s) => ({ saveStatus: { ...s.saveStatus, [id]: 'saved' } }));
      const t = savedTimers.get(id);
      if (t) clearTimeout(t);
      savedTimers.set(
        id,
        setTimeout(() => clearSaved(id), SAVED_FADE_MS),
      );
    })
    .catch((e: unknown) =>
      uiActions.toast(`Saving note failed — ${errorText(e)}`, 'error'),
    );
};

const queueSave = (id: string, patch: { title?: string; text?: string }) => {
  const prev = pending.get(id);
  if (prev) clearTimeout(prev.timer);
  pending.set(id, {
    timer: setTimeout(() => save(id), SAVE_DELAY_MS),
    patch: { ...prev?.patch, ...patch },
  });
};

export const notesActions = {
  /* optimistic with a client-minted id, so the editor can open immediately */
  createNote() {
    const now = Date.now();
    const n: Note = {
      id: uuid(),
      title: 'Untitled note',
      text: '',
      createdAt: now,
      updatedAt: now,
    };
    setNoteItems([n, ...get().notes]);
    const req = notesApi
      .create({ id: n.id, title: n.title, text: n.text })
      .catch((e: unknown) => {
        setNoteItems(get().notes.filter((x) => x.id !== n.id));
        uiActions.toast(`Create note failed — ${errorText(e)}`, 'error');
        throw e;
      })
      .finally(() => creating.delete(n.id));
    creating.set(n.id, req);
    uiActions.navigateTo(`/notes/${n.id}`);
    return n.id;
  },
  editNote(id: string, text: string, title?: string) {
    const cur = get().notes.find((n) => n.id === id);
    if (!cur) return;
    /* dismiss a lingering "Saved" as soon as the note is edited again */
    clearSaved(id);
    setNoteItems(
      get().notes.map((n) =>
        n.id === id
          ? {
              ...n,
              text,
              ...(title !== undefined ? { title } : {}),
              updatedAt: Date.now(),
            }
          : n,
      ),
    );
    /* the server rejects blank titles; keep the last good one until the field has text again */
    const t = title?.trim();
    queueSave(id, { text, ...(t ? { title: t } : {}) });
  },
  /** sends any debounced edit now, e.g. when leaving the editor */
  flushNote(id: string) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    save(id);
  },
  deleteNote(id: string) {
    const prev = get().notes;
    if (!prev.some((n) => n.id === id)) return;
    const p = pending.get(id);
    if (p) clearTimeout(p.timer);
    pending.delete(id);
    clearSaved(id);
    setNoteItems(prev.filter((n) => n.id !== id));
    void (creating.get(id) ?? Promise.resolve())
      .then(
        () => notesApi.remove(id),
        () => undefined,
      )
      .catch((e: unknown) => {
        setNoteItems(prev);
        uiActions.toast(`Delete note failed — ${errorText(e)}`, 'error');
      });
  },
  attachNote(id: string) {
    const n = get().notes.find((x) => x.id === id);
    if (!n) return;
    draftActions.addAttachments([
      { id: uid(), kind: 'note', name: `note: ${n.title}`, noteId: n.id },
    ]);
  },
};
