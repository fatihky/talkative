/*
 * MessageBubble — one turn in a thread, rendered as the clean-layout
 * handoff's `.msg`: an avatar column, a mono meta row ("You"/model,
 * time), a bubble around the body, and a hover-revealed action row.
 *
 * Business logic:
 * - the meta row shows "You" or the replying model (internal provider
 *   prefix stripped), a status suffix — interrupted means the server
 *   restarted mid-reply — plus the time of day with a full timestamp
 *   tooltip.
 * - user turns are editable unless in flight; saving sends the edited
 *   copy as a new sibling branch, preserving the original.
 * - assistant replies with a parent can be regenerated as a sibling
 *   branch using the currently selected model.
 * - edit/regen/delete are disabled while the chat is busy — the server
 *   generates one reply at a time.
 * - delete confirms with the full subtree size (nested branches
 *   included); the server drops the subtree and prunes uploads no
 *   surviving message references.
 * - a refusal renders as a "model declined" panel; url_citation
 *   annotations render as Sources links.
 * - done assistant replies expose a usage tooltip: input/cached/output/
 *   reasoning/total tokens, provider-reported cost, latency.
 * - image attachments render inline linking to /api/attachments/<id>,
 *   other kinds as named chips; BranchNav appears only when the turn
 *   has siblings.
 */
'use client';

import { useState } from 'react';
import { $fmt, fullTimestamp, timeOfDay } from '../../lib/format';
import { I } from '../../lib/icons';
import { removalSet } from '../../lib/message-tree';
import { Tip } from '../../lib/popover';
import { actions, type Msg, useThreadsStore } from '../../stores';
import { BranchNav } from './branch-nav';
import { CopyButton } from './copy-button';
import { EditBox } from './edit-box';
import { MessageBody } from './message-body';

const STATUS_LABEL: Partial<Record<Msg['status'], string>> = {
  sending: ' · sending',
  queued: ' · queued',
  failed: ' · failed',
  error: ' · failed',
  /* the server restarted mid-reply; the text up to the last flush is kept */
  interrupted: ' · interrupted',
};

/* build a detailed tooltip label from usage + latency */
const statsTooltip = (m: Pick<Msg, 'usage' | 'latencyMs'>): string | null => {
  if (!m.usage) return null;
  const u = m.usage;
  const lines: string[] = [];
  lines.push(`Input: ${u.promptTokens.toLocaleString()}`);
  lines.push(`Cached input: ${(u.cachedTokens ?? 0).toLocaleString()}`);
  lines.push(`Output: ${u.completionTokens.toLocaleString()}`);
  if (u.reasoningTokens)
    lines.push(`· Reasoning: ${u.reasoningTokens.toLocaleString()}`);
  lines.push(`Total: ${u.totalTokens.toLocaleString()}`);
  if (u.costUsd != null) lines.push(`Cost: ${$fmt(u.costUsd)}`);
  if (m.latencyMs != null && m.latencyMs > 0)
    lines.push(`Latency: ${(m.latencyMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
};

const ATTACH_ICON: Partial<Record<Msg['attachments'][number]['kind'], string>> = {
  note: 'note',
  image: 'image',
  url: 'link',
  memory: 'brain',
  chat: 'chat',
};

export function MessageBubble({
  m,
  chatId,
  siblings,
  busy,
}: {
  m: Msg;
  chatId: string;
  siblings: string[];
  /* a reply is generating somewhere in the chat; the server takes one at a time */
  busy: boolean;
}) {
  const isUser = m.role === 'user';
  const [editing, setEditing] = useState(false);
  const canEdit = isUser && m.status !== 'sending' && m.status !== 'queued';
  /* a reply still generating has nothing to redo yet */
  const canRegen = !isUser && m.parentId !== null && m.status !== 'streaming';
  const canDelete =
    m.status !== 'streaming' && m.status !== 'sending' && m.status !== 'queued';
  const remove = () => {
    const t = useThreadsStore.getState().threads[chatId];
    const n = t ? removalSet(t.messages, m.id).ids.size : 1;
    if (
      !window.confirm(
        n > 1
          ? `Delete this message and ${n - 1} after it on this and any nested branches?`
          : 'Delete this message?',
      )
    )
      return;
    actions.deleteMessage(chatId, m.id);
  };

  const modelLabel = !isUser && m.modelId ? m.modelId.replace(/^\d+:/, '') : '';

  return (
    <article className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="msg-row">
        <div className="msg-avatar">
          <I n={isUser ? 'user' : 'bot'} s={14} />
        </div>

        <div className="msg-body">
          <div className="msg-meta">
            <span>{isUser ? 'You' : modelLabel || 'Assistant'}</span>
            {m.createdAt && (
              <Tip label={fullTimestamp(m.createdAt)} side="bottom">
                <span className="num cursor-default">
                  {timeOfDay(m.createdAt)}
                </span>
              </Tip>
            )}
            {STATUS_LABEL[m.status] && <span>{STATUS_LABEL[m.status]}</span>}
          </div>

          {editing ? (
            <EditBox
              initial={m.content}
              onCancel={() => setEditing(false)}
              onSave={(text) => {
                setEditing(false);
                actions.editAndResend(chatId, m.id, text);
              }}
            />
          ) : (
            <div className="bubble">
              {m.content || m.toolCalls?.length || m.thoughts?.length ? (
                <MessageBody
                  msgId={m.id}
                  chatId={chatId}
                  content={m.content}
                  calls={m.toolCalls ?? []}
                  thoughts={m.thoughts ?? []}
                  live={m.status === 'streaming'}
                  onRetry={
                    canRegen && !busy
                      ? (callId) => actions.retryToolCall(chatId, m.id, callId)
                      : undefined
                  }
                />
              ) : (
                <span className="muted">…</span>
              )}
              {m.refusal && (
                <div className="mt-1.5 flex gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--sunken)] px-2 py-1.5 text-[12px]">
                  <I n="alert" s={12} className="mt-0.5 shrink-0 muted" />
                  <div className="min-w-0">
                    <div className="font-medium">
                      The model declined this request
                    </div>
                    <div className="mt-0.5 whitespace-pre-wrap break-words muted">
                      {m.refusal}
                    </div>
                  </div>
                </div>
              )}
              {m.annotations && m.annotations.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-1">
                  <div className="sec-label">Sources</div>
                  {m.annotations.map((a) => (
                    <a
                      key={a.url}
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 truncate rounded-sm px-1 py-0.5 text-[11px] text-[var(--text-2)] hover:bg-[var(--sunken)] hover:text-[var(--text)]"
                    >
                      <I n="link" s={10} className="shrink-0 muted" />
                      <span className="truncate">{a.title || a.url}</span>
                    </a>
                  ))}
                </div>
              )}
              {m.error && (
                <div className="num mt-1.5 text-[11px] text-(--danger)">
                  {m.error}
                </div>
              )}
              {m.attachments.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {m.attachments.some((a) => a.kind === 'image') && (
                    <div className="flex flex-wrap gap-2">
                      {m.attachments
                        .filter((a) => a.kind === 'image')
                        .map((a) => (
                          <a
                            key={a.id}
                            href={`/api/attachments/${a.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block"
                          >
                            <img
                              src={`/api/attachments/${a.id}`}
                              alt={a.name}
                              className="max-h-72 max-w-full rounded-md border border-[var(--border)] bg-[var(--sunken)] object-contain"
                            />
                          </a>
                        ))}
                    </div>
                  )}
                  {m.attachments.some((a) => a.kind !== 'image') && (
                    <div className="flex flex-wrap gap-1.5">
                      {m.attachments
                        .filter((a) => a.kind !== 'image')
                        .map((a) => (
                          <span
                            key={a.id}
                            className="flex h-5 items-center gap-1 rounded-sm border border-border bg-sidebar px-1.5 text-[11px] muted"
                          >
                            <I n={ATTACH_ICON[a.kind] ?? 'file'} s={10} />{' '}
                            {a.name}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!editing && (
            <div className="msg-actions">
              {siblings.length > 1 && (
                <BranchNav chatId={chatId} ids={siblings} id={m.id} />
              )}

              {m.content && <CopyButton text={m.content} />}

              {!isUser && m.status === 'done' && m.usage && (
                <Tip label={statsTooltip(m)} side="top">
                  <button
                    type="button"
                    className="icon-only"
                    aria-label="Provider stats"
                  >
                    <I n="info" s={12} />
                  </button>
                </Tip>
              )}

              {canEdit && (
                <Tip label="Edit — sends as a new branch" side="top">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing(true)}
                    aria-label="Edit message"
                    className="icon-only"
                  >
                    <I n="pencil" s={12} />
                  </button>
                </Tip>
              )}
              {canRegen && (
                <Tip label="Regenerate with the selected model" side="top">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => actions.regenerate(chatId, m.id)}
                    aria-label="Regenerate reply"
                    className="icon-only"
                  >
                    <I n="retry" s={12} />
                  </button>
                </Tip>
              )}
              {canDelete && (
                <Tip label="Delete" side="top">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={remove}
                    aria-label="Delete message"
                    className="icon-only"
                  >
                    <I n="trash" s={12} />
                  </button>
                </Tip>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
