/*
 * estimate / getEstimate / useEstimate — the token, cost and context
 * numbers behind the composer. No store and no persistence: everything is
 * recomputed from the draft, threads and models stores on each read.
 *
 * Business logic:
 * - counting is a coarse heuristic, not a tokenizer: ceil(chars / 4)
 *   (GROSS_TOKENS) for text, ceil(bytes / 4) for each attachment.
 * - `tokens` is only what's about to be sent (composer text plus
 *   attachments); `contextUsed` adds the thread history to it, and cost
 *   prices `tokens` alone at the model's input rate.
 * - history counts just the branch on screen — branchPath(messages,
 *   leafId), the same root-to-leaf path the server replays upstream — so
 *   sibling branches left behind by an edit, retry or regenerate are inert
 *   and switching branches moves the meter.
 * - each history message contributes its content plus every tool call's
 *   args and result, since all of that goes back upstream too.
 * - which text is measured depends on context: the home draft on 'new',
 *   the thread's own draft inside a chat; attachments always come from the
 *   shared draft store.
 * - overflow needs a window: it's true only when the model reports
 *   context.window and contextUsed exceeds it, so a model without a window
 *   can never overflow.
 * - useEstimate(pick) subscribes through useShallow so a caller re-renders
 *   only when its picked fields change; getEstimate() is the non-reactive
 *   read beginSend() uses to refuse an overflowing message.
 * - consumers: the composer's token/cost readout and blocked-send reason,
 *   the tool bar's context meter, and the home-only overflow banner.
 */
'use client';

import { useShallow } from 'zustand/react/shallow';
import { GROSS_TOKENS } from '../lib/format';
import type { Draft, Model } from '../types';
import { getSelectedModel, useDraftStore, useSelectedModel } from './draft';
import { type Thread, branchPath, useThreadsStore } from './threads';
import { usePrivateStore } from './transient';
import { useUIStore } from './ui';

export type Estimate = {
  tokens: number;
  cost: number;
  contextUsed: number;
  window: number | null;
  overflow: boolean;
  hasAttachments: boolean;
};

const messageTokens = (m: {
  content: string;
  toolCalls?: { args: string; result?: string | undefined }[] | undefined;
}): number => {
  let tokens = GROSS_TOKENS(m.content);
  for (const c of m.toolCalls ?? [])
    tokens += GROSS_TOKENS(c.args) + GROSS_TOKENS(c.result ?? '');
  return tokens;
};

/* only the branch on screen is sent upstream, so only that one counts; the
   other branches of the tree are inert */
const historyTokens = (thread: Thread | undefined): number =>
  thread
    ? branchPath(thread.messages, thread.leafId).reduce(
        (acc, m) => acc + messageTokens(m),
        0,
      )
    : 0;

/** `history` is the token count of the open thread's branch (0 on home). */
export const estimate = (
  draft: Pick<Draft, 'text' | 'attachments'>,
  model: Model | null,
  history: number,
): Estimate => {
  const attachTok = draft.attachments.reduce(
    (acc, a) => acc + (a.bytes ? Math.ceil(a.bytes / 4) : 0),
    0,
  );
  const tokens = GROSS_TOKENS(draft.text) + attachTok;
  const contextUsed = tokens + history;
  const window = model?.context.window ?? null;
  return {
    tokens,
    cost: (tokens / 1_000_000) * (model?.pricing.input ?? 0),
    contextUsed,
    window,
    overflow: window != null && contextUsed > window,
    hasAttachments: draft.attachments.length > 0,
  };
};

export const getEstimate = (): Estimate => {
  const { context } = useUIStore.getState();
  const { attachments, text: homeText } = useDraftStore.getState();
  if (context === 'private') {
    const msgs = usePrivateStore.getState().messages;
    const history = msgs.reduce((acc, m) => acc + messageTokens(m), 0);
    return estimate(
      { text: usePrivateStore.getState().draft, attachments: [] },
      getSelectedModel(),
      history,
    );
  }
  const thread =
    context === 'new' ? undefined : useThreadsStore.getState().threads[context];
  /* in a thread the composer text lives on the thread, not the home draft */
  const text = context === 'new' ? homeText : (thread?.draft ?? '');
  return estimate(
    { text, attachments },
    getSelectedModel(),
    historyTokens(thread),
  );
};

/** Subscribe to a projection of the estimate; `pick` should return primitives or a flat object of them. */
export function useEstimate<T>(pick: (e: Estimate) => T): T {
  const model = useSelectedModel();
  const context = useUIStore((s) => s.context);
  const history = useThreadsStore((s) =>
    context === 'new' ? 0 : historyTokens(s.threads[context]),
  );
  const privateHistory = usePrivateStore((s) =>
    context === 'private'
      ? s.messages.reduce((acc, m) => acc + messageTokens(m), 0)
      : 0,
  );
  /* in a thread the composer text lives on the thread, not the home draft */
  const threadText = useThreadsStore((s) =>
    context === 'new' ? null : (s.threads[context]?.draft ?? ''),
  );
  const privateText = usePrivateStore((s) =>
    context === 'private' ? s.draft : null,
  );
  return useDraftStore(
    useShallow((d) =>
      pick(
        estimate(
          {
            text:
              privateText ??
              threadText ??
              d.text,
            attachments: context === 'private' ? [] : d.attachments,
          },
          model,
          privateText !== null ? privateHistory : history,
        ),
      ),
    ),
  );
}
