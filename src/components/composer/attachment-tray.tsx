/*
 * AttachmentTray — chips for the attachments staged with the composer's
 * next message.
 *
 * Business logic:
 * - hidden until something is staged; shows at most 6 chips and a "+N"
 *   counter for the rest.
 * - chip icon follows the attachment kind (image/note/url, file
 *   fallback); the name truncates and a stored upload adds its size.
 * - scope 'chat' items get a badge: they were dropped as chat context,
 *   not just for the next message.
 * - the x unstages (removeAttachment); an upload taken back out before
 *   sending is orphaned and collected later by `pnpm uploads:gc`.
 * - staged items ride with the next send: images go to the model as
 *   image_url parts, text is inlined into the prompt, urls pass
 *   through.
 */
'use client';

import { bytesFmt } from '../../lib/format';
import { I } from '../../lib/icons';
import { actions } from '../../stores';
import type { Attachment } from '../../types';

const ICONS = {
  image: 'image',
  note: 'note',
  url: 'link',
  memory: 'brain',
  chat: 'chat',
} as const;

function AttachmentChip({
  a,
  onRemove,
}: {
  a: Attachment;
  onRemove: () => void;
}) {
  const icon = ICONS[a.kind as keyof typeof ICONS] ?? 'file';
  return (
    <span className="inline-flex h-5 max-w-full items-center gap-1 rounded-[4px] border border-[var(--border)] bg-[var(--sunken)] pl-1.5 pr-0.5 text-[12px]">
      <I n={icon} s={12} className="shrink-0 muted" />
      <span className="max-w-[160px] truncate">{a.name}</span>
      {a.bytes !== undefined && (
        <span className="num shrink-0 muted">{bytesFmt(a.bytes)}</span>
      )}
      {a.scope === 'chat' && (
        <span className="shrink-0 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-1 text-[10px] muted">
          chat
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${a.name}`}
        onClick={onRemove}
        className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[var(--text-3)] hover:bg-[var(--border)] hover:text-[var(--text)]"
      >
        <I n="x" s={10} />
      </button>
    </span>
  );
}

export function AttachmentTray({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  const shown = attachments.slice(0, 6);
  const rest = attachments.length - shown.length;
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset styling is not wanted for a chip row
    <div
      className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1"
      role="group"
      aria-label="Attachments"
    >
      {shown.map((a) => (
        <AttachmentChip
          key={a.id}
          a={a}
          onRemove={() => actions.removeAttachment(a.id)}
        />
      ))}
      {rest > 0 && <span className="num text-[11px] muted">+{rest}</span>}
    </div>
  );
}
