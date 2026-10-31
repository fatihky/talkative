/*
 * EditBox — inline editor for a user message.
 *
 * Business logic:
 * - saving doesn't mutate the turn: it sends the edited copy as a
 *   sibling branch, preserving the original and its replies.
 * - empty or whitespace-only text can't be saved.
 * - Enter follows the enterToSend pref (an account setting), ⌘/Ctrl+Enter
 *   always saves, Escape cancels.
 * - opens focused with the caret at the end of the text; the box fits
 *   2–12 rows of content.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefsStore } from '../../stores';

export function EditBox({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const enterToSend = usePrefsStore((s) => s.enterToSend);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  /* auto-grow to fit the content, capped at 12 rows */
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const min = lineH * 2;
    const max = lineH * 12;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text]);
  const save = () => {
    if (text.trim() !== '') onSave(text);
  };
  return (
    <div className="flex w-full max-w-[92%] flex-col gap-2 rounded-[8px] border border-[var(--accent)] bg-[var(--raised)] p-2">
      <textarea
        ref={ref}
        value={text}
        rows={2}
        aria-label="Edit message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (e.key === 'Enter' && (mod || (!e.shiftKey && enterToSend))) {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') onCancel();
        }}
        className="scroll-thin w-full resize-none overflow-hidden bg-transparent text-[13px] leading-[1.55] outline-none"
      />
      <div className="flex justify-end gap-2">
        <button type="button" className="ctl h-7 px-3" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ctl-primary h-7 px-3"
          disabled={text.trim() === ''}
          onClick={save}
        >
          Send
        </button>
      </div>
    </div>
  );
}
