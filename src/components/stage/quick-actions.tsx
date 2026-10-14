/*
 * QuickActions — home shortcut row: attach, new note, context, artifact.
 *
 * Business logic:
 * - addFromFiles uploads through attachFiles() into the draft store and is
 *   shared with the stage's file-drop handling.
 * - The attach button opens a hidden multi-file input scoped to 'message';
 *   the input's value resets after each pick so choosing the same file
 *   again still fires.
 * - iconOnly mode (narrow screens) drops the labels for tooltips.
 * - Note/context/artifact buttons create a note or open the matching
 *   right-panel tab.
 */
'use client';

import { useRef } from 'react';
import { attachFiles } from '../../lib/attachments';
import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';
import { actions } from '../../stores';

export function addFromFiles(files: FileList, scope: 'message' | 'chat') {
  void attachFiles([...files], scope).then(actions.addAttachments);
}

export function QuickActions({ iconOnly = false }: { iconOnly?: boolean }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="mt-6 flex items-center gap-2">
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) addFromFiles(e.target.files, 'message');
          e.target.value = '';
        }}
      />
      <QA
        icon="paperclip"
        label="Attach file"
        iconOnly={iconOnly}
        onClick={() => fileRef.current?.click()}
      />
      <QA
        icon="note"
        label="New note"
        iconOnly={iconOnly}
        onClick={() => actions.createNote()}
      />
      <QA
        icon="info"
        label="Chat context"
        iconOnly={iconOnly}
        onClick={() => actions.openPanel('context')}
      />
      <QA
        icon="grid"
        label="Artifact panel"
        iconOnly={iconOnly}
        onClick={() => actions.openPanel('artifact')}
      />
    </div>
  );
}

function QA({
  icon,
  label,
  onClick,
  iconOnly,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  iconOnly: boolean;
}) {
  return (
    <Tip label={iconOnly ? label : null} side="top">
      <button
        type="button"
        onClick={onClick}
        className="ctl-ghost inline-flex h-7 shrink-0 items-center gap-1.5 px-2 text-[12px]"
        aria-label={label}
      >
        <I n={icon} s={13} />
        {!iconOnly && <span>{label}</span>}
      </button>
    </Tip>
  );
}
