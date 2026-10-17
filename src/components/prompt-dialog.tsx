/*
 * PromptDialog — a one-line modal prompt that answers `actions.askText()`,
 * used to rename a chat from the thread header, where the sidebar's
 * inline editor isn't on screen.
 *
 * Business logic:
 * - Mounted once in the shell next to the confirm dialog; ui.askText
 *   parks a request (title, label, initial text, confirm label) and
 *   resolves with the trimmed text, or null on cancel, esc, backdrop or
 *   when replaced by a newer prompt.
 * - Reuses Modal, so esc, the scrim and the focus handling behave like
 *   every other dialog.
 * - Blank input can't be submitted (the confirm button stays disabled),
 *   so the caller never has to read "" as "clear it".
 * - Renders nothing while no request is open.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { actions, useUIStore } from '../stores';
import { Modal } from '../ui/modal';

/** answers `actions.askText()`; mounted once in the shell */
export function PromptDialog() {
  const req = useUIStore((s) => s.textPrompt);
  if (!req) return null;
  /* keyed by the request, so a new prompt always starts from its own initial text */
  return <Editor key={req.id} />;
}

function Editor() {
  const req = useUIStore((s) => s.textPrompt);
  const [text, setText] = useState(req?.initial ?? '');
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  if (!req) return null;
  const cancel = () => actions.answerText(null);
  const canSave = text.trim() !== '';
  const save = () => {
    if (canSave) actions.answerText(text.trim());
  };

  return (
    <Modal
      title={req.title}
      icon="pencil"
      onClose={cancel}
      footer={
        <>
          <button
            type="button"
            onClick={cancel}
            className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="ctl-primary h-7 rounded-[6px] px-3 text-[12px] disabled:opacity-50"
          >
            {req.confirmLabel ?? 'Save'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          aria-label={req.label ?? req.title}
          className="h-8 w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--sunken)] px-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      </form>
    </Modal>
  );
}
