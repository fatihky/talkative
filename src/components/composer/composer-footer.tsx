/*
 * ComposerFooter — bottom strip of the composer: estimates, attach,
 * model bar, send hint, and send button.
 *
 * Business logic:
 * - shows the live token estimate and ~cost of the next send, dimmed
 *   while the draft is empty.
 * - the attach button only appears on wide (≥768px) layouts.
 * - the send-key hint follows the enterToSend pref (Enter vs
 *   ⌘/Ctrl+Enter) and is replaced by "Queued on reconnect" offline. The
 *   hint is a button: clicking it flips the account pref, so the
 *   composer's Enter behaviour can be switched without a trip to settings.
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
  actions,
  useLayoutStore,
  useNetworkStore,
  usePrefsStore,
  useUIStore,
} from '../../stores';
import { Kbd } from '../../ui/primitives';
import { ModelPicker, ParamsButton } from './model-picker';
import { SendButton } from './send-button';

/** one-shot toggle: stamp history turns with their timestamps on the next send */
function TimestampToggle() {
  const on = useUIStore((s) => s.timestampPrefix);
  return (
    <Tip
      label={
        on
          ? 'Timestamps on — next send prefixes every message with its time.\n[2026/10/20 09:15] let’s start planning'
          : 'Prefix history with message timestamps for one send.\n\nTurns each message into "[2026/10/20 09:15] …" so the model sees the timeline.'
      }
      side="top"
    >
      <button
        type="button"
        aria-pressed={on}
        aria-label="Prefix history with message timestamps"
        onClick={() => actions.setTimestampPrefix(!on)}
        className={`ctl-icon size-5 border-transparent bg-transparent ${
          on
            ? 'text-[var(--accent)] hover:bg-[var(--sunken)]'
            : 'text-[var(--text-3)] hover:bg-[var(--sunken)]'
        }`}
      >
        <I n="clock" s={13} />
      </button>
    </Tip>
  );
}

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
        <TimestampToggle />
        {wide && (
          <Tip
            label={
              enterToSend
                ? 'Enter sends the message.\nClick to make Enter start a new line.'
                : 'Enter starts a new line; the send shortcut still sends.\nClick to make Enter send.'
            }
            side="top"
          >
            <button
              type="button"
              aria-pressed={!enterToSend}
              aria-label="Toggle Enter to send"
              onClick={() => actions.setEnterToSend(!enterToSend)}
              className="flex items-center gap-1.5 rounded-[4px] px-1 text-[11px] muted hover:bg-[var(--sunken)] hover:text-[var(--text-2)]"
            >
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
            </button>
          </Tip>
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
