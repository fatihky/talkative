/*
 * usePrivateStore / privateActions — the unsaved "private" chat: one flat
 * in-memory conversation that is never persisted to the server or the db.
 *
 * Business logic:
 * - the conversation lives only in this client store; there is no ChatSummary
 *   row, no localStorage mirror, and no server record. reloading drops it, but
 *   navigating away and back within this session restores it.
 * - every send posts the whole conversation as `history` plus the new user
 *   turn (see sendTransientMessage), so the server rebuilds context without a
 *   stored row; the assistant reply streams back through readTransientStream.
 * - tools are off for private chats: the send carries no grants and the
 *   composer hides the tool bar when the private chat is open.
 * - a failed send keeps the turn and raises `error` for retry; the draft is
 *   never cleared on failure.
 */
'use client';

import { create } from 'zustand';
import type { StreamEnd, TransientTurn } from '../lib/api';
import {
  ApiError,
  readTransientStream,
  sendTransientMessage,
  stopTransientMessage,
} from '../lib/api';
import { uid } from '../lib/storage';
import type { MessageStatus, ToolCall } from '../types';
import { useDraftStore } from './draft';
import { isOffline, useNetworkStore } from './network';
import { uiActions } from './ui';

export type PrivateMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus | 'sending' | 'failed';
  error?: string;
  usage?: StreamEnd['usage'];
  createdAt: number;
};

type PrivateState = {
  messages: PrivateMsg[];
  draft: string;
  streaming: boolean;
  error?: { text: string } | undefined;
};

export const usePrivateStore = create<PrivateState>()(() => ({
  messages: [],
  draft: '',
  streaming: false,
}));

const get = usePrivateStore.getState;
const set = usePrivateStore.setState;

const patchMsg = (id: string, patch: Partial<PrivateMsg>) =>
  set({
    messages: get().messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  });

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* open stream subscription by assistant message id; aborting only detaches the client */
const live = new Map<string, AbortController>();
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const upsertTool = (_call: ToolCall) => {
  /* private chats never run tools; kept for signature symmetry with the thread store */
};

const finishStream = (msgId: string, end: StreamEnd) => {
  patchMsg(msgId, {
    status: end.status,
    ...(end.error ? { error: end.error } : {}),
    ...(end.usage ? { usage: end.usage } : {}),
  });
  set({ streaming: false });
  if (end.status === 'error')
    uiActions.toast(`Reply failed — ${end.error ?? 'provider error'}`, 'error');
};

const followStream = async (msgId: string) => {
  if (live.has(msgId)) return;
  const ctrl = new AbortController();
  live.set(msgId, ctrl);
  set({ streaming: true });
  let backoff = 500;
  try {
    while (!ctrl.signal.aborted) {
      const offset =
        get().messages.find((m) => m.id === msgId)?.content.length ?? 0;
      try {
        const end = await readTransientStream(
          msgId,
          offset,
          {
            delta: (text) => {
              backoff = 500;
              const m = get().messages.find((x) => x.id === msgId);
              if (m) patchMsg(msgId, { content: m.content + text });
            },
            tool: upsertTool,
            thought: () => {},
            thoughtDelta: () => {},
          },
          ctrl.signal,
        );
        if (end) {
          finishStream(msgId, end);
          return;
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) {
          finishStream(msgId, {
            status: 'error',
            error: 'reply no longer exists',
          });
          return;
        }
      }
      await delay(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  } finally {
    live.delete(msgId);
  }
};

export const privateActions = {
  privateSetText(text: string) {
    set({ draft: text });
  },
  clear() {
    set({ messages: [], draft: '', streaming: false, error: undefined });
  },

  /** sends the draft as a new user turn in the private chat */
  privateSend() {
    const { draft, streaming, messages } = get();
    const text = draft.trim();
    if (text === '' || streaming) return;
    const d = useDraftStore.getState();

    const userMsg: PrivateMsg = {
      id: uid(),
      role: 'user',
      content: text,
      status: 'sending',
      createdAt: Date.now(),
    };
    const nextMessages = [...messages, userMsg];
    set({ messages: nextMessages, draft: '', error: undefined });

    if (isOffline()) {
      set({ error: { text: 'Offline — message not sent' } });
      patchMsg(userMsg.id, { status: 'failed' });
      return;
    }

    const history = [
      ...nextMessages
        .filter((m) => m.role === 'user' || m.status === 'done')
        .map((m) => ({ role: m.role, content: m.content }) as TransientTurn),
    ];

    sendTransientMessage(
      {
        modelId: d.modelId,
        thinkingLevel: d.thinkingLevel,
        history,
      },
      useNetworkStore.getState().dev,
    )
      .then((res) => {
        const assistant = res.assistant;
        const assistantMsg: PrivateMsg = {
          id: assistant.id,
          role: 'assistant',
          content: assistant.content,
          status: 'streaming',
          createdAt: Date.now(),
        };
        set({
          messages: [
            ...nextMessages.map((m) =>
              m.id === userMsg.id
                ? ({ ...m, status: 'done' } as PrivateMsg)
                : m,
            ),
            assistantMsg,
          ],
        });
        void followStream(assistant.id);
      })
      .catch((e: unknown) => {
        patchMsg(userMsg.id, { status: 'failed' });
        set({ error: { text: errorText(e) } });
        uiActions.toast(`Send failed — ${errorText(e)}`, 'error');
      });
  },

  /** retries the last failed user turn */
  retry() {
    const { messages } = get();
    const failed = messages.findLast(
      (m) => m.role === 'user' && m.status === 'failed',
    );
    if (!failed) return;
    /* drop the failed turn and resend its text */
    set({
      messages: messages.filter((m) => m.id !== failed.id),
      error: undefined,
      draft: failed.content,
    });
    privateActions.privateSend();
  },

  /** stops the live reply; the open stream delivers the final 'stopped' status */
  privateStop() {
    const msg = get().messages.findLast(
      (m) => m.role === 'assistant' && m.status === 'streaming',
    );
    if (!msg) return;
    stopTransientMessage(msg.id).catch((e: unknown) =>
      uiActions.toast(
        `Couldn't stop — ${e instanceof Error ? e.message : 'error'}`,
        'error',
      ),
    );
  },

  /** removes a single turn (and no descendants — the private chat is flat) */
  remove(id: string) {
    if (get().streaming) return;
    set({ messages: get().messages.filter((m) => m.id !== id) });
  },
};
