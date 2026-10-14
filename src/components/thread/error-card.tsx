/*
 * ErrorCard — S18 send-failed alert at the end of a thread.
 *
 * Business logic:
 * - announces the server's error text assertively; a failed send keeps
 *   the route and never clears the content silently.
 * - Retry resends the stored payload as-is, flipping the failed turn
 *   back to sending.
 * - Edit message pulls the failed text back into the composer draft,
 *   removes the optimistic turn, and rewinds the leaf to its parent.
 */
'use client';

import { useMemo } from 'react';
import { I } from '../../lib/icons';
import { actions } from '../../stores';

/* S18 — send failed */
export function ErrorCard({ chatId, text }: { chatId: string; text: string }) {
  const retry = useMemo(() => () => actions.retrySend(chatId), [chatId]);
  const edit = useMemo(() => () => actions.editMessage(chatId), [chatId]);
  return (
    <div
      className="rounded-[8px] border border-[var(--danger)] bg-[var(--panel)] p-3"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--danger)]">
        <I n="alert" s={14} /> Message failed to send
      </div>
      <div className="num mt-1 text-[11px] muted">{text}</div>
      <div className="mt-2 flex gap-2">
        <button type="button" className="ctl h-7 px-3" onClick={retry}>
          Retry
        </button>
        <button type="button" className="ctl h-7 px-3" onClick={edit}>
          Edit message
        </button>
      </div>
    </div>
  );
}
