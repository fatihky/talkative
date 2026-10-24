/*
 * ThreadsStore — the message tree of every open chat, the branch on
 * screen, and the streams that fill replies in.
 *
 * Business logic:
 * - one Thread per chatId: every branch as a flat, oldest-first messages
 *   array linked by parentId, plus leafId (the tip on screen), that chat's
 *   own composer draft, streaming, the failed-send error, the client-side
 *   send queue, and a session-wide sessionCost that nothing renders. all
 *   of it is server-derived or optimistic — none of it is persisted.
 * - Msg widens the server status with the client-only 'sending', 'queued'
 *   and 'failed'; those turns have no row, so neither switchBranch nor
 *   deleteMessage will PATCH a leafId pointing at one, and a delete of an
 *   unsent turn never reaches the server.
 * - branchPath walks leaf → root and reverses: that path is all the
 *   thread view renders and all the token estimate counts, while the rest
 *   of the array feeds the per-parent sibling map behind BranchNav.
 * - switchBranch first records the child shown under each parent of the
 *   path being left in the module-level `picks` map (per chat, not
 *   persisted), then deepestLeaf follows those picks — else the newest
 *   child — down to the new tip, so nested branch choices survive
 *   navigating away and back; the leaf is PATCHed to the chat so a reload
 *   reopens the same branch, and a failed PATCH costs only that memory.
 * - loadThread fetches a chat once (the `loading` set dedupes remounts),
 *   re-checks the store after the await in case a send from this tab
 *   created the thread meanwhile, re-attaches to any assistant message
 *   still 'streaming', and on 404 leaves an empty thread and toasts. a
 *   thread already in memory is only re-seeded: the composer takes the
 *   newest modelId on the visible branch (else the chat row's) and the
 *   newest user turn's tool grants, for that chat alone.
 * - attachStream follows one reply keyed by message id (`live` stops a
 *   double attach) and resumes from the length of the text already
 *   received as the stream offset, so a network blip, server restart or
 *   sleep continues in place, retrying with a 500ms→10s backoff; a 404
 *   settles it as 'reply no longer exists'.
 * - SSE events mutate the tree in place: delta appends to content, tool
 *   upserts by call id (events repeat on reconnect and on every status
 *   change) and reveals an artifact snapshot, thought replaces a step's
 *   block while thought-delta appends to it, and done writes
 *   status/usage/latency/refusal/annotations, clears streaming, toasts on
 *   error and drains the send queue through the hook send.ts registers
 *   with onStreamSettled — send.ts imports this file, so importing it
 *   back would be circular.
 * - stopStream only POSTs /stop for the newest streaming reply: the open
 *   subscription then delivers the final 'stopped' status, so the client
 *   never aborts its own stream and the run keeps going server-side.
 * - deleteMessage is refused while streaming or when the subtree it would
 *   remove includes a live stream; it drops the removalSet subtree, lands
 *   on the deepest surviving sibling (or the removed root's parent),
 *   clears the error card once no failed turn is left, and on server
 *   failure puts the old messages back while keeping anything that
 *   arrived meanwhile.
 * - exportChat downloads the visible branch as .txt with thinking and
 *   tool steps inline, appending any off-branch messages after it, while
 *   editMessage turns the failed turn's stored payload back into the
 *   composer draft and removes that turn.
 */
'use client';

import { create } from 'zustand';
import {
  ApiError,
  chatsApi,
  deleteMessage,
  type OutgoingMessage,
  readStream,
  type SendResult,
  type StreamEnd,
  stopMessage,
} from '../lib/api';
import { callSnapshot } from '../lib/artifacts';
import {
  chatToText,
  downloadText,
  type ExportableMessage,
  exportFilename,
  pathToLeaf,
} from '../lib/export-chat';
import { removalSet } from '../lib/message-tree';
import { DEFAULT_PROVIDERS } from '../lib/tools';
import type {
  ChatSummary,
  Message,
  MessageStatus,
  Thought,
  ToolCall,
} from '../types';
import { artifactsActions } from './artifacts';
import { setChatItems, useChatsStore } from './chats';
import { draftActions, normalizeGrants, useDraftStore } from './draft';
import { uiActions } from './ui';

/* server statuses, plus the client-only lifecycle of a user message before the server has it */
export type Msg = Omit<Message, 'status'> & {
  status: MessageStatus | 'sending' | 'queued' | 'failed';
};

/** a message waiting to be sent once the current stream finishes */
export type QueuedMessage = {
  id: string;
  content: string;
  attachments: unknown[];
  payload: OutgoingMessage;
  createdAt: number;
};

export type Thread = {
  /* every branch, oldest first; parentId links them into a tree */
  messages: Msg[];
  /* tip of the branch on screen */
  leafId: string | null;
  draft: string;
  streaming: boolean;
  error?: { text: string; payload: OutgoingMessage } | undefined;
  /** messages queued while the assistant is generating */
  queue: QueuedMessage[];
};

type ThreadsState = {
  threads: Record<string, Thread>;
  sessionCost: number;
};

export const useThreadsStore = create<ThreadsState>()(() => ({
  threads: {},
  sessionCost: 0,
}));

const get = useThreadsStore.getState;

export const putThread = (chatId: string, thread: Thread) =>
  useThreadsStore.setState({ threads: { ...get().threads, [chatId]: thread } });

/** shallow-merge into an existing thread; no-op if the thread is gone */
export const patchThread = (chatId: string, patch: Partial<Thread>) => {
  const t = get().threads[chatId];
  if (t) putThread(chatId, { ...t, ...patch });
};

const patchMsg = (chatId: string, msgId: string, patch: Partial<Msg>) => {
  const t = get().threads[chatId];
  if (t)
    putThread(chatId, {
      ...t,
      messages: t.messages.map((m) =>
        m.id === msgId ? { ...m, ...patch } : m,
      ),
    });
};

const UNSENT: ReadonlySet<Msg['status']> = new Set([
  'sending',
  'queued',
  'failed',
]);

/** root-to-leaf path: the messages actually on screen */
export const branchPath = (messages: Msg[], leafId: string | null): Msg[] => {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const out: Msg[] = [];
  for (
    let m = leafId ? byId.get(leafId) : undefined;
    m && out.length < messages.length;
    m = m.parentId ? byId.get(m.parentId) : undefined
  )
    out.push(m);
  return out.reverse();
};

/* per chat, the child last shown under each parent, so switching an upper branch away and
   back doesn't reset the branches nested below it */
const picks = new Map<string, Map<string | null, string>>();

/** the composer reopens with the model of the newest message on the branch on screen */
export const applyThreadModel = (chatId: string) => {
  const t = get().threads[chatId];
  if (!t) return;
  let id: string | undefined;
  const path = branchPath(t.messages, t.leafId);
  for (let i = path.length - 1; i >= 0 && !id; i--) id = path[i]?.modelId;
  id ??= useChatsStore.getState().items.find((c) => c.id === chatId)?.modelId;
  if (id) draftActions.applyChatModel(id);
};

/** the composer reopens with the tools the newest user turn on the branch was sent with */
const applyThreadTools = (chatId: string) => {
  const t = get().threads[chatId];
  if (!t) return;
  const path = branchPath(t.messages, t.leafId);
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i];
    if (m?.role !== 'user' || !m.toolGrants) continue;
    draftActions.adoptStoredTools(chatId, {
      grants: normalizeGrants(m.toolGrants),
      providers: { ...DEFAULT_PROVIDERS, ...m.toolProviders },
      counts: useDraftStore.getState().defaultTools.counts,
      concurrency: useDraftStore.getState().defaultTools.concurrency,
    });
    return;
  }
};

/** follows the last-shown child at each level (else the newest), landing on that branch's tip */
const deepestLeaf = (
  messages: Msg[],
  id: string,
  picked: Map<string | null, string>,
): string => {
  let leaf = id;
  for (let i = 0; i < messages.length; i++) {
    const pick = picked.get(leaf);
    const child =
      messages.find((m) => m.id === pick && m.parentId === leaf) ??
      messages.findLast((m) => m.parentId === leaf);
    if (!child) break;
    leaf = child.id;
  }
  return leaf;
};

export const addSessionCost = (usd: number) =>
  useThreadsStore.setState({ sessionCost: get().sessionCost + usd });

export const upsertChat = (chat: ChatSummary) => {
  const items = useChatsStore.getState().items;
  setChatItems(
    items.some((c) => c.id === chat.id)
      ? items.map((c) => (c.id === chat.id ? chat : c))
      : [chat, ...items],
  );
};

/* open stream subscriptions by assistant message id; aborting one only detaches the client */
const live = new Map<string, AbortController>();
const MAX_BACKOFF_MS = 10_000;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* tool events repeat on every reconnect and on each status change, so merge by id */
const upsertToolCall = (chatId: string, msgId: string, call: ToolCall) => {
  const m = get().threads[chatId]?.messages.find((x) => x.id === msgId);
  if (!m) return;
  const list = m.toolCalls ?? [];
  patchMsg(chatId, msgId, {
    toolCalls: list.some((c) => c.id === call.id)
      ? list.map((c) => (c.id === call.id ? call : c))
      : [...list, call],
  });
};

/* snapshots replace a block whole (reconnects resend them); deltas append to it */
const putThought = (
  chatId: string,
  msgId: string,
  step: number,
  next: (prev: Thought | undefined) => Thought,
) => {
  const m = get().threads[chatId]?.messages.find((x) => x.id === msgId);
  if (!m) return;
  const list = m.thoughts ?? [];
  const prev = list.find((t) => t.step === step);
  patchMsg(chatId, msgId, {
    thoughts: prev
      ? list.map((t) => (t === prev ? next(prev) : t))
      : [...list, next(undefined)],
  });
};

export const followStream = (chatId: string, msgId: string) =>
  void attachStream(chatId, msgId);

let drainQueue: (chatId: string) => void = () => {};
export const onStreamSettled = (fn: (chatId: string) => void) => {
  drainQueue = fn;
};

const finishStream = (chatId: string, msgId: string, end: StreamEnd) => {
  patchMsg(chatId, msgId, {
    status: end.status,
    ...(end.error ? { error: end.error } : {}),
    ...(end.usage ? { usage: end.usage } : {}),
    ...(end.latencyMs != null ? { latencyMs: end.latencyMs } : {}),
    ...(end.refusal ? { refusal: end.refusal } : {}),
    ...(end.annotations ? { annotations: end.annotations } : {}),
  });
  patchThread(chatId, { streaming: false });
  if (end.status === 'error')
    uiActions.toast(`Reply failed — ${end.error ?? 'provider error'}`, 'error');
  /* send the next queued message now that the stream is done */
  drainQueue(chatId);
};

/**
 * follows an assistant reply until it settles. the cursor is simply the text already
 * received, so a dropped connection (network blip, server restart, sleep) resumes in place.
 */
const attachStream = async (chatId: string, msgId: string) => {
  if (live.has(msgId)) return;
  const ctrl = new AbortController();
  live.set(msgId, ctrl);
  patchThread(chatId, { streaming: true });
  let backoff = 500;
  try {
    while (!ctrl.signal.aborted) {
      const offset =
        get().threads[chatId]?.messages.find((m) => m.id === msgId)?.content
          .length ?? 0;
      try {
        const end = await readStream(
          msgId,
          offset,
          {
            delta: (text) => {
              backoff = 500;
              const m = get().threads[chatId]?.messages.find(
                (x) => x.id === msgId,
              );
              if (m) patchMsg(chatId, msgId, { content: m.content + text });
            },
            tool: (call) => {
              backoff = 500;
              upsertToolCall(chatId, msgId, call);
              const s = callSnapshot(call);
              if (s) artifactsActions.revealArtifact(chatId, s.id);
            },
            thought: (thought) => {
              backoff = 500;
              putThought(chatId, msgId, thought.step, () => thought);
            },
            thoughtDelta: (d) => {
              backoff = 500;
              putThought(chatId, msgId, d.step, (prev) =>
                prev ? { ...prev, text: prev.text + d.text } : d,
              );
            },
          },
          ctrl.signal,
        );
        if (end) {
          finishStream(chatId, msgId, end);
          return;
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) {
          finishStream(chatId, msgId, {
            status: 'error',
            error: 'reply no longer exists',
          });
          return;
        }
      }
      await delay(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  } finally {
    live.delete(msgId);
  }
};

/* thread ids whose server load is in flight, so remounts don't double-fetch */
const loading = new Set<string>();

export const threadsActions = {
  setThreadText(chatId: string, text: string) {
    patchThread(chatId, { draft: text });
  },

  setMsgStatus(chatId: string, msgId: string, status: Msg['status']) {
    if (msgId) patchMsg(chatId, msgId, { status });
  },

  /** swaps the optimistic user turn for the stored one and follows the new reply */
  applySent(chatId: string, localMsgId: string, res: SendResult) {
    const t = get().threads[chatId];
    if (!t) return;
    const messages = t.messages.some((m) => m.id === localMsgId)
      ? t.messages.map((m) => (m.id === localMsgId ? res.user : m))
      : [...t.messages, res.user];
    putThread(chatId, {
      ...t,
      messages: [...messages, res.assistant],
      leafId: res.assistant.id,
    });
    upsertChat(res.chat);
    void attachStream(chatId, res.assistant.id);
  },

  /** loads a thread the client hasn't seen this session and re-attaches to a reply still in flight */
  async loadThread(chatId: string) {
    if (chatId === '') return;
    /* opening an existing chat leaves the new-chat folder context behind */
    useDraftStore.setState({ pendingFolderId: null });
    /* revisiting a chat already in memory still re-selects its model */
    if (get().threads[chatId]) {
      applyThreadModel(chatId);
      applyThreadTools(chatId);
      return;
    }
    if (loading.has(chatId)) return;
    loading.add(chatId);
    try {
      const { chat, messages, leafId } = await chatsApi.get(chatId);
      /* a send from this tab may have created the thread while we were fetching */
      if (get().threads[chatId]) {
        applyThreadModel(chatId);
        applyThreadTools(chatId);
        return;
      }
      putThread(chatId, {
        messages,
        leafId,
        draft: '',
        streaming: false,
        queue: [],
      });
      upsertChat(chat);
      applyThreadModel(chatId);
      applyThreadTools(chatId);
      for (const m of messages)
        if (m.role === 'assistant' && m.status === 'streaming')
          void attachStream(chatId, m.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        putThread(chatId, {
          messages: [],
          leafId: null,
          draft: '',
          streaming: false,
          queue: [],
        });
        uiActions.toast('Chat not found', 'warn');
      } else
        uiActions.toast(
          `Couldn't load chat — ${e instanceof Error ? e.message : 'error'}`,
          'error',
        );
    } finally {
      loading.delete(chatId);
    }
  },

  /** asks the server to stop; the open stream then delivers the final 'stopped' status */
  stopStream(chatId: string) {
    const t = get().threads[chatId];
    const m = t?.messages.findLast(
      (x) => x.role === 'assistant' && x.status === 'streaming',
    );
    if (!m) return;
    stopMessage(m.id).catch((e: unknown) =>
      uiActions.toast(
        `Couldn't stop — ${e instanceof Error ? e.message : 'error'}`,
        'error',
      ),
    );
  },

  /** shows the branch through message `msgId` (one of its siblings) and remembers it server-side */
  switchBranch(chatId: string, msgId: string) {
    const t = get().threads[chatId];
    if (!t) return;
    const picked = picks.get(chatId) ?? new Map<string | null, string>();
    picks.set(chatId, picked);
    /* remember the path being left before descending into the new one */
    for (const m of branchPath(t.messages, t.leafId))
      picked.set(m.parentId, m.id);
    const leafId = deepestLeaf(t.messages, msgId, picked);
    if (leafId === t.leafId) return;
    putThread(chatId, { ...t, leafId });
    /* unsent messages have no server row to point at */
    const leaf = t.messages.find((m) => m.id === leafId);
    if (leaf && !UNSENT.has(leaf.status))
      chatsApi.patch(chatId, { leafId }).catch(() => {
        /* only the remembered branch is lost; the view already switched */
      });
  },

  /** drops message `msgId` and what follows it (see removalSet), then lands on a surviving branch */
  deleteMessage(chatId: string, msgId: string) {
    const t = get().threads[chatId];
    if (!t || t.streaming) return;
    const { ids, root } = removalSet(t.messages, msgId);
    if (!root || [...ids].some((id) => live.has(id))) return;
    const messages = t.messages.filter((m) => !ids.has(m.id));
    const leafGone = t.leafId !== null && ids.has(t.leafId);
    const sibling = messages.findLast((m) => m.parentId === root.parentId);
    const leafId = !leafGone
      ? t.leafId
      : sibling
        ? deepestLeaf(messages, sibling.id, picks.get(chatId) ?? new Map())
        : root.parentId;
    putThread(chatId, {
      ...t,
      messages,
      leafId,
      /* the error card belongs to a failed turn; it goes with it */
      error: messages.some((m) => m.status === 'failed') ? t.error : undefined,
    });
    /* a turn the server never stored only lived here */
    if (UNSENT.has(root.status)) return;
    deleteMessage(root.id)
      .then((chat) => {
        upsertChat(chat);
        /* the server falls back to the newest branch; keep the one on screen instead */
        const leaf = messages.find((m) => m.id === leafId);
        if (leafGone && leaf && !UNSENT.has(leaf.status))
          chatsApi.patch(chatId, { leafId: leaf.id }).catch(() => {
            /* only the remembered branch is lost */
          });
      })
      .catch((e: unknown) => {
        /* put the rows back, keeping anything that arrived meanwhile */
        const cur = get().threads[chatId];
        if (cur)
          putThread(chatId, {
            ...cur,
            messages: [
              ...t.messages,
              ...cur.messages.filter(
                (m) => !t.messages.some((x) => x.id === m.id),
              ),
            ],
            leafId: t.leafId,
          });
        uiActions.toast(
          `Delete failed — ${e instanceof Error ? e.message : 'error'}`,
          'error',
        );
      });
  },

  /** downloads the branch on screen as a plain-text file, thinking and tool steps included */
  exportChat(chatId: string) {
    const t = get().threads[chatId];
    if (!t) return;
    const chat = useChatsStore.getState().items.find((c) => c.id === chatId);
    /* only the visible branch is exported; append any messages not yet in the leaf's path */
    const path = pathToLeaf(t.messages, t.leafId);
    const inPath = new Set(path.map((m) => m.id));
    const all: Msg[] = [
      ...path,
      ...t.messages.filter((m) => !inPath.has(m.id)),
    ];
    if (all.length === 0) {
      uiActions.toast('Nothing to export', 'warn');
      return;
    }
    const title = chat?.title ?? 'Chat';
    downloadText(
      exportFilename(title),
      chatToText(
        { title, modelId: chat?.modelId, createdAt: chat?.createdAt },
        all as ExportableMessage[],
      ),
    );
    uiActions.toast('Chat exported', 'info');
  },

  editMessage(chatId: string) {
    const t = get().threads[chatId];
    const err = t?.error;
    if (!t || !err) return;
    const failed = t.messages.findLast(
      (m) => m.role === 'user' && m.status === 'failed',
    );
    putThread(chatId, {
      ...t,
      messages: failed
        ? t.messages.filter((m) => m.id !== failed.id)
        : t.messages,
      ...(failed ? { leafId: failed.parentId } : {}),
      draft: err.payload.content,
      error: undefined,
    });
    draftActions.focusComposer();
  },
};
