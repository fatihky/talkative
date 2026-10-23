/*
 * estimate / getEstimate / useEstimate — the token, cost and context
 * numbers behind the composer. No store and no persistence: everything is
 * recomputed from the draft, threads and models stores on each read.
 *
 * Business logic:
 * - counting is a coarse heuristic, not a tokenizer: ceil(chars / 4)
 *   (GROSS_TOKENS) for text, ceil(bytes / 4) for each attachment.
 * - `tokens` is only what's about to be sent (composer text plus
 *   attachments); `contextUsed` adds the thread history and the effective
 *   system prompt to it, and cost prices `tokens` alone at the model's
 *   input rate.
 * - the effective system prompt is the chat's folder chain outermost-first
 *   plus its own prompt (on home: the pending folder chain and the draft's
 *   pending prompt), counted like the rest — ceil(chars / 4) — and kept as
 *   separate folder and chat parts for the context meter's tooltip.
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
import type { Draft, Folder, Model } from '../types';
import { useChatsStore } from './chats';
import { getSelectedModel, useDraftStore, useSelectedModel } from './draft';
import { useFoldersStore } from './folders';
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
  /** effective system prompt total, split by where it comes from */
  systemTokens: number;
  systemFolderTokens: number;
  systemChatTokens: number;
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

/**
 * tokens of the effective system prompt, matching what systemTurns() assembles
 * server-side: every ancestor folder's prompt (outermost first) then the chat's
 * own. `folderId` and `chatPrompt` are the pending ones on home.
 */
const systemPromptTokens = (
  folders: Folder[],
  folderId: string | null | undefined,
  chatPrompt: string | null | undefined,
): { folder: number; chat: number } => {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  /* bounded walk so a corrupt cache can't spin forever */
  for (
    let f = folderId ? byId.get(folderId) : undefined, n = 0;
    f && n <= folders.length;
    f = f.parentId ? byId.get(f.parentId) : undefined, n++
  )
    if (f.systemPrompt?.trim()) parts.unshift(f.systemPrompt.trim());
  const chat = chatPrompt?.trim();
  return {
    folder: parts.length > 0 ? GROSS_TOKENS(parts.join('\n\n')) : 0,
    chat: chat ? GROSS_TOKENS(chat) : 0,
  };
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
  system: { folder: number; chat: number } = { folder: 0, chat: 0 },
): Estimate => {
  const attachTok = draft.attachments.reduce(
    (acc, a) => acc + (a.bytes ? Math.ceil(a.bytes / 4) : 0),
    0,
  );
  const tokens = GROSS_TOKENS(draft.text) + attachTok;
  const systemTokens = system.folder + system.chat;
  const contextUsed = tokens + history + systemTokens;
  const window = model?.context.window ?? null;
  return {
    tokens,
    cost: (tokens / 1_000_000) * (model?.pricing.input ?? 0),
    contextUsed,
    window,
    overflow: window != null && contextUsed > window,
    hasAttachments: draft.attachments.length > 0,
    systemTokens,
    systemFolderTokens: system.folder,
    systemChatTokens: system.chat,
  };
};

export const getEstimate = (): Estimate => {
  const draft = useDraftStore.getState();
  const { context } = useUIStore.getState();
  if (context === 'private') {
    const msgs = usePrivateStore.getState().messages;
    const history = msgs.reduce((acc, m) => acc + messageTokens(m), 0);
    return estimate(
      { text: usePrivateStore.getState().draft, attachments: [] },
      getSelectedModel(),
      history,
    );
  }
  const folders = useFoldersStore.getState().items;
  if (context === 'new') {
    return estimate(
      { text: draft.text, attachments: draft.attachments },
      getSelectedModel(),
      0,
      systemPromptTokens(folders, draft.pendingFolderId, draft.systemPrompt),
    );
  }
  const thread = useThreadsStore.getState().threads[context];
  const chat = useChatsStore.getState().items.find((c) => c.id === context);
  /* in a thread the composer text lives on the thread, not the home draft */
  return estimate(
    { text: thread?.draft ?? '', attachments: draft.attachments },
    getSelectedModel(),
    historyTokens(thread),
    systemPromptTokens(folders, chat?.folderId, chat?.systemPrompt),
  );
};

/** Subscribe to a projection of the estimate; `pick` should return primitives or a flat object of them. */
export function useEstimate<T>(pick: (e: Estimate) => T): T {
  const model = useSelectedModel();
  const context = useUIStore((s) => s.context);
  const folders = useFoldersStore((s) => s.items);
  const chat = useChatsStore((s) =>
    context === 'new' || context === 'private'
      ? null
      : (s.items.find((c) => c.id === context) ?? null),
  );
  const pendingFolderId = useDraftStore((s) => s.pendingFolderId);
  const pendingPrompt = useDraftStore((s) => s.systemPrompt);
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
  const system =
    context === 'private'
      ? { folder: 0, chat: 0 }
      : context === 'new'
        ? systemPromptTokens(folders, pendingFolderId, pendingPrompt)
        : systemPromptTokens(folders, chat?.folderId, chat?.systemPrompt);
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
          system,
        ),
      ),
    ),
  );
}
