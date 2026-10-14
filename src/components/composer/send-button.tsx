/*
 * SendButton — send/queue/stop control at the composer's right edge.
 *
 * Business logic:
 * - aria-disabled while the composer reports a blockedReason; the
 *   reason lives in the footer's sr-only #send-reason node.
 * - during a live run a stop button appears (stops the current
 *   context's stream) and the tooltip becomes "Queue message (N
 *   queued)" — sending while generating queues instead of failing.
 * - offline the tooltip promises queueing; held sends flush on
 *   reconnect.
 * - a badge shows the pending queue count while nothing is sending; a
 *   spinner replaces the arrow while a send is in flight.
 */
'use client';

import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';
import { actions, useUIStore } from '../../stores';

const BASE = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px]';

export function SendButton({
  streaming,
  sending,
  blockedReason,
  offline,
  queueCount,
  onSend,
}: {
  streaming: boolean;
  sending: boolean;
  blockedReason: string | null;
  offline: boolean;
  queueCount: number;
  onSend: () => void;
}) {
  const disabled = blockedReason !== null;
  return (
    <div className="flex items-center gap-1">
      {streaming && (
        <button
          type="button"
          aria-label="Stop generating"
          onClick={() => {
            const ctx = useUIStore.getState().context;
            if (ctx === 'private') actions.privateStop();
            else actions.stopStream(ctx);
          }}
          className={`${BASE} border border-[var(--border-strong)] bg-[var(--sunken)] text-[var(--text)] hover:bg-[var(--border)]`}
        >
          <I n="stop" s={12} />
        </button>
      )}
      <Tip
        label={
          blockedReason ??
          (streaming
            ? `Queue message${queueCount > 0 ? ` (${queueCount} queued)` : ''}`
            : offline
              ? 'Offline — message will queue'
              : 'Send message')
        }
        side="top"
      >
        <div className="relative">
          <button
            type="button"
            aria-disabled={disabled}
            aria-describedby={blockedReason ? 'send-reason' : undefined}
            onClick={onSend}
            className={`${BASE} transition-colors ${
              disabled
                ? 'cursor-not-allowed bg-[var(--sunken)] text-[var(--text-3)]'
                : 'bg-[var(--accent)] text-[var(--text-inv)] hover:opacity-90'
            }`}
          >
            {sending ? (
              <span
                className="block size-3.5 animate-spin rounded-full border-2 border-[var(--text-3)] border-t-transparent"
                role="status"
                aria-label="Sending"
              />
            ) : (
              <I n="arrow-up" s={14} w={2} />
            )}
          </button>
          {queueCount > 0 && !sending && (
            <span className="absolute -right-1.5 -top-1.5 flex size-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--danger)] px-0.5 text-[8px] font-bold leading-none text-white">
              {queueCount}
            </span>
          )}
        </div>
      </Tip>
    </div>
  );
}
