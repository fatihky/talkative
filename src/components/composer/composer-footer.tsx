/*
 * ComposerFooter — bottom strip of the composer: estimates, attach,
 * model bar, send hint, and send button.
 *
 * Business logic:
 * - shows the live token estimate and ~cost of the next send, dimmed
 *   while the draft is empty.
 * - the attach button only appears on wide (≥768px) layouts.
 * - the send-key hint follows the enterToSend pref (Enter vs
 *   ⌘/Ctrl+Enter) and is replaced by "Queued on reconnect" offline.
 * - streaming/sending/blockedReason/queueCount pass through to the
 *   SendButton, so sending during a live run queues the turn instead
 *   of being rejected.
 * - an sr-only #send-reason node mirrors blockedReason for screen
 *   readers.
 */
'use client';

import { $fmt, kfmt } from '../../lib/format';
import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';
import {
  useLayoutStore,
  useNetworkStore,
  usePrefsStore,
  useUIStore,
} from '../../stores';
import { Kbd } from '../../ui/primitives';
import { ModelPicker, ParamsButton } from './model-picker';
import { SendButton } from './send-button';

export function ComposerFooter({
  empty,
  tokens,
  cost,
  actualCost,
  streaming,
  sending,
  blockedReason,
  queueCount,
  onAttach,
  onSend,
}: {
  empty: boolean;
  tokens: number;
  cost: number;
  /* provider-reported cost of the last reply, when the API returned one */
  actualCost: number | null;
  streaming: boolean;
  sending: boolean;
  blockedReason: string | null;
  queueCount: number;
  onAttach: () => void;
  onSend: () => void;
}) {
  const enterToSend = usePrefsStore((s) => s.enterToSend);
  const conn = useNetworkStore((s) => s.connection);
  const mod = useUIStore((s) => s.mod);
  const wide = useLayoutStore((s) => s.vw >= 768);

  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-t border-[var(--border)] px-2">
      <div className="num flex min-w-0 items-center gap-1 text-[11px]">
        <span className={empty ? 'muted' : ''}>
          {tokens === 0 ? '0 tok' : `${kfmt(tokens)} tok`}
        </span>
        {actualCost != null ? (
          <span className="muted">· {$fmt(actualCost)}</span>
        ) : !empty ? (
          <span className="muted">· ~{$fmt(cost)} est</span>
        ) : null}
        {wide && (
          <Tip label="Attach file" side="top">
            <button
              type="button"
              aria-label="Attach file"
              onClick={onAttach}
              className="ctl-icon ml-1 size-5 border-transparent bg-transparent text-[var(--text-3)] hover:bg-[var(--sunken)]"
            >
              <I n="paperclip" s={12} />
            </button>
          </Tip>
        )}
      </div>
      <div className="flex items-center gap-2" id="composer-hint">
        <ModelPicker /> <ParamsButton />
        {wide && (
          <span className="flex items-center gap-1.5 text-[11px] muted">
            {conn === 'offline' ? (
              'Queued on reconnect'
            ) : enterToSend ? (
              <>
                Enter to send <Kbd>⏎</Kbd>
              </>
            ) : (
              <>
                {mod}+Enter to send <Kbd>{mod}⏎</Kbd>
              </>
            )}
          </span>
        )}
        <SendButton
          streaming={streaming}
          sending={sending}
          blockedReason={blockedReason}
          offline={conn === 'offline'}
          queueCount={queueCount}
          onSend={onSend}
        />
        <span id="send-reason" className="sr-only">
          {blockedReason ?? ''}
        </span>
      </div>
    </div>
  );
}
