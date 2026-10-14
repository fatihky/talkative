/*
 * ConfirmDialog — the app-wide modal that answers `actions.confirm()`.
 *
 * Business logic:
 * - Mounted once in the shell so every destructive or irreversible flow
 *   (delete a chat or note, publish, unpublish or remove an artifact)
 *   asks the same way; only one request can be open at a time.
 * - Resolves the caller's promise: the confirm button true, and cancel,
 *   esc, backdrop press or close false — dismissing is always a "no", and
 *   a newer confirm() call resolves the one it replaced with false.
 * - Focus lands on Cancel on open so a stray Enter can't confirm.
 * - `danger` requests get the trash icon and destructive button style;
 *   the label defaults to "Confirm" and callers pass their own
 *   ("Publish", "Make private", "Remove").
 * - Renders nothing while no request is open and persists nothing itself.
 */
'use client';

import { useEffect, useRef } from 'react';
import { actions, useUIStore } from '../stores';
import { Modal } from '../ui/modal';

/** answers `actions.confirm()`; mounted once in the shell */
export function ConfirmDialog() {
  const req = useUIStore((s) => s.confirm);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  /* focus lands on cancel so a stray enter doesn't confirm */
  useEffect(() => {
    if (req) cancelRef.current?.focus();
  }, [req]);

  if (!req) return null;
  const cancel = () => actions.answerConfirm(false);
  return (
    <Modal
      title={req.title}
      icon={req.danger ? 'trash' : 'alert'}
      onClose={cancel}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={cancel}
            className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => actions.answerConfirm(true)}
            className={`${req.danger ? 'ctl-danger' : 'ctl-primary'} h-7 rounded-[6px] px-3 text-[12px]`}
          >
            {req.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      {req.body}
    </Modal>
  );
}
