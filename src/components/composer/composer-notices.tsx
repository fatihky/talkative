/*
 * Composer notices — DraftNotice, LongPasteBar, NoToolsNote.
 *
 * Business logic:
 * - DraftNotice: a saved home draft was restored at boot; Discard
 *   resets to a fresh draft while model and tool prefs are kept.
 * - LongPasteBar: shown when a paste pushes the home draft past 2000
 *   chars; offers to convert the whole draft into a pasted-text.txt
 *   file attachment, or to dismiss.
 * - NoToolsNote: shown after sending a message with no attachments and
 *   no tool grants; one click grants web_search.
 */
'use client';

import { actions } from '../../stores';

export function DraftNotice() {
  return (
    <div
      className="mb-1 flex h-5 items-center gap-2 text-[12px] muted"
      role="status"
    >
      <span>Draft restored</span>
      <button
        type="button"
        className="hover:text-[var(--text)]"
        onClick={() => actions.discardDraft()}
      >
        Discard
      </button>
    </div>
  );
}

export function LongPasteBar() {
  return (
    <div
      className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-0.5 text-[12px]"
      role="status"
    >
      <span className="muted">That is a big paste.</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-[var(--accent)] hover:underline"
          onClick={() => actions.convertPasteToFile()}
        >
          Convert to file attachment?
        </button>
        <button
          type="button"
          className="muted hover:text-[var(--text)]"
          aria-label="Dismiss"
          onClick={() => actions.dismissLongPaste()}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function NoToolsNote() {
  return (
    <div className="mt-1 flex h-5 items-center gap-2 text-[12px]" role="status">
      <span className="muted">No tools granted for this message</span>
      <button
        type="button"
        className="text-[var(--accent)] hover:underline"
        onClick={() => actions.setToolGrant('web_search', true)}
      >
        Enable web_search
      </button>
    </div>
  );
}
