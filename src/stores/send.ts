/*
 * sendActions — every path that puts a user turn on the wire: a new
 * chat's first send, replies, edits, queued turns, regenerate and tool
 * retries. it owns no state; the tree lives in ThreadsStore.
 *
 * Business logic:
 * - beginSend (home) mints the chat uuid and the turn id client-side,
 *   writes an optimistic one-message thread, prepends the chat row, and
 *   sets context + pendingNav so the shell navigates before the server
 *   answers — the server adopts those ids. the composer draft and
 *   'home.draft' are cleared only once the POST succeeds.
 * - a send is refused (returns null) when the estimate overflows the
 *   model's context window, or when the draft has neither text nor an
 *   attachment; sending with no tools and no attachment raises the
 *   noToolsNote hint.
 * - a home draft's chat-scope system prompt travels with the first send
 *   (so the server stores it on the row it creates) and seeds the new
 *   chat's sidebar row; it is home state, so a failed send keeps it.
 * - offline, beginSend marks the turn 'queued' and parks its payload in
 *   network.queued; flushQueue replays all of them on reconnect and marks
 *   whatever fails 'failed'.
 * - a failed send never loses the text: the turn goes to 'failed' and
 *   thread.error keeps the exact payload, which retrySend re-posts and
 *   threads.editMessage puts back into the composer.
 * - sendReply appends to thread.queue while a reply is streaming;
 *   drainQueue (registered with onStreamSettled, so finishStream calls
 *   it) sends one at a time and resolves parentId at send time, so each queued turn follows the
 *   latest reply. dequeueMessage drops one that hasn't started yet.
 * - a reply parents to the last assistant message on the visible branch,
 *   and an earlier failed turn with that same parent is removed so it
 *   doesn't linger as a phantom branch.
 * - editAndResend adds a sibling of the original user turn — same parent,
 *   same attachments — and moves the leaf onto it, leaving the old branch
 *   and its replies intact; it is refused while streaming.
 * - regenerate and retryToolCall both go through startBranch: refused
 *   while streaming or offline, they hold streaming=true across the
 *   round-trip so the composer can't send into the same turn, append the
 *   new sibling reply, move the leaf to it and follow its stream. a tool
 *   retry keeps the model that started the reply, a regenerate uses the
 *   composer's current one.
 * - payloadFor stamps each turn with the composer's model, thinking level
 *   and param overrides (paramScope 'message') plus only the grants the
 *   selected model supports, and remembers the chat's tool selection so
 *   the tool bar restores per chat.
 * - a first send also files the new chat into the folder it was started
 *   from and fires classifyChat non-blocking for its category and tags;
 *   the estimate's cost is added to threads.sessionCost.
 */
'use client';

import {
  ApiError,
  chatsApi,
  classifyChat,
  type OutgoingMessage,
  type RegenerateResult,
  regenerateMessage,
  retryToolCall,
  sendMessage,
} from '../lib/api';
import { LS, uid, uuid } from '../lib/storage';
import type { ChatSummary } from '../types';
import { setClassifying, useChatsStore } from './chats';
import {
  effectiveGrants,
  knownModelId,
  rememberActiveTools,
  setDraft,
  useDraftStore,
} from './draft';
import { getEstimate } from './estimate';
import { isOffline, useNetworkStore } from './network';
import {
  addSessionCost,
  branchPath,
  followStream,
  type Msg,
  onStreamSettled,
  patchThread,
  putThread,
  type QueuedMessage,
  threadsActions,
  upsertChat,
  useThreadsStore,
} from './threads';
import { uiActions, useUIStore } from './ui';

const { setMsgStatus, applySent } = threadsActions;
const dev = () => useNetworkStore.getState().dev;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** payload carrying the composer's model + params; the turn keeps its own tool selection */
const payloadFor = (
  chatId: string,
  content: string,
  attachments: OutgoingMessage['attachments'],
  parentId: string | null,
): OutgoingMessage => {
  const d = useDraftStore.getState();
  rememberActiveTools(chatId);
  /* one-shot: consume the timestamp-prefix toggle, then reset it */
  const timestamps = useUIStore.getState().timestampPrefix;
  if (timestamps) useUIStore.setState({ timestampPrefix: false });
  return {
    role: 'user',
    content,
    attachments,
    parentId,
    modelId: d.modelId,
    thinkingLevel: d.thinkingLevel,
    toolGrants: effectiveGrants(),
    toolProviders: d.toolProviders,
    paramOverrides: d.paramOverrides,
    paramScope: 'message',
    timestamps,
  };
};

/** starts a server-side reply that branches off an existing one, then follows its stream */
const startBranch = (
  chatId: string,
  verb: string,
  req: () => Promise<RegenerateResult>,
) => {
  const t = useThreadsStore.getState().threads[chatId];
  if (!t || t.streaming) return;
  if (isOffline()) {
    uiActions.toast(`Offline — can't ${verb}`, 'warn');
    return;
  }
  /* covers the round-trip so the composer can't send into the same turn meanwhile */
  patchThread(chatId, { streaming: true });
  req()
    .then((res) => {
      const cur = useThreadsStore.getState().threads[chatId];
      if (!cur) return;
      putThread(chatId, {
        ...cur,
        messages: [...cur.messages, res.assistant],
        leafId: res.assistant.id,
      });
      upsertChat(res.chat);
      followStream(chatId, res.assistant.id);
    })
    .catch((e: unknown) => {
      patchThread(chatId, { streaming: false });
      uiActions.toast(
        `${verb[0]?.toUpperCase()}${verb.slice(1)} failed — ${errorText(e)}`,
        'error',
      );
    });
};

export const sendActions = {
  /* send (§7.2) */
  beginSend(): string | null {
    const est = getEstimate();
    const draft = useDraftStore.getState();
    const text = draft.text.trim();
    const hasAtt = draft.attachments.length > 0;
    if (est.overflow) return null;
    if (text === '' && !hasAtt) return null;
    const folderId = draft.pendingFolderId ?? undefined;
    const systemPrompt = draft.systemPrompt.trim();

    /* minted here so we can navigate before the server answers; the server adopts it */
    const chatId = uuid();
    const title =
      text === ''
        ? (draft.attachments[0]?.name ?? 'New chat')
        : text.slice(0, 48);
    const chat: ChatSummary = {
      id: chatId,
      title,
      modelId: draft.modelId,
      branchCount: 1,
      messageCount: 1,
      costUsd: 0,
      tags: [],
      ...(folderId ? { folderId } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      firstPrompt: text,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const userMsg: Msg = {
      id: uid(),
      parentId: null,
      role: 'user',
      content: text,
      attachments: draft.attachments,
      createdAt: Date.now(),
      status: 'sending',
    };
    const payload: OutgoingMessage = {
      ...payloadFor(chatId, text, draft.attachments, null),
      /* the server stores it on the row it creates, so the first reply already has it */
      ...(systemPrompt ? { systemPrompt } : {}),
    };

    putThread(chatId, {
      messages: [userMsg],
      leafId: userMsg.id,
      draft: '',
      streaming: false,
      queue: [],
    });
    useChatsStore.setState({
      items: [chat, ...useChatsStore.getState().items],
    });
    setClassifying(chatId, true);
    useUIStore.setState({
      context: chatId,
      pendingNav: chatId,
      sending: true,
      draftNotice: false,
    });

    if (!hasAtt && Object.values(draft.toolGrants).every((v) => v !== true)) {
      useUIStore.setState({ noToolsNote: true });
    }

    if (isOffline()) {
      setMsgStatus(chatId, userMsg.id, 'queued');
      useNetworkStore.setState({
        queued: [
          ...useNetworkStore.getState().queued,
          { chatId, msgId: userMsg.id, payload },
        ],
      });
      uiActions.toast('Offline — message queued', 'warn');
      useUIStore.setState({ sending: false });
      return chatId;
    }

    sendMessage(chatId, payload, dev())
      .then((res) => {
        LS.del('home.draft');
        setDraft({ text: '', attachments: [] });
        useDraftStore.setState({ systemPrompt: '' });
        /* the chat just started on this model; it is now the default the next new chat gets */
        LS.set('home.lastModel', payload.modelId);
        addSessionCost(est.cost);
        useUIStore.setState({ sending: false, noToolsNote: false });
        applySent(chatId, userMsg.id, res);
        /* the chat row is created server-side on first send; file it into the folder it was started from */
        if (folderId) {
          chatsApi
            .patch(chatId, { folderId })
            .then((updated) => upsertChat(updated))
            .catch(() => {
              /* the chat stays at the top level if the move is refused */
            });
        }
        /* classification: fires on the first user message, non-blocking (§7.2) */
        classifyChat(chatId)
          .then((c) => {
            const patch = {
              ...(c.category ? { category: c.category } : {}),
              ...(c.tags ? { tags: c.tags } : {}),
            };
            useChatsStore.setState({
              items: useChatsStore
                .getState()
                .items.map((x) => (x.id === chatId ? { ...x, ...patch } : x)),
            });
            return chatsApi.patch(chatId, patch);
          })
          .catch(() => {
            /* silently omit */
          })
          .finally(() => setClassifying(chatId, false));
      })
      .catch((e: unknown) => {
        /* S18: keep route; ErrorCard; never clear the draft */
        setMsgStatus(chatId, userMsg.id, 'failed');
        patchThread(chatId, { error: { text: errorText(e), payload } });
        useUIStore.setState({ sending: false });
        uiActions.toast(
          `Send failed — ${e instanceof ApiError ? `${e.status} ` : ''}${e instanceof Error ? e.message : 'unknown error'}`,
          'error',
        );
      });
    return chatId;
  },

  retrySend(chatId: string) {
    const t = useThreadsStore.getState().threads[chatId];
    if (!t?.error) return;
    const payload = t.error.payload;
    patchThread(chatId, { error: undefined });
    const userMsg = t.messages.findLast(
      (m) => m.role === 'user' && m.status === 'failed',
    );
    setMsgStatus(chatId, userMsg?.id ?? '', 'sending');
    sendMessage(chatId, payload, dev())
      .then((res) => {
        addSessionCost(0.002);
        applySent(chatId, userMsg?.id ?? '', res);
      })
      .catch((e: unknown) => {
        setMsgStatus(chatId, userMsg?.id ?? '', 'failed');
        patchThread(chatId, { error: { text: errorText(e), payload } });
      });
  },

  sendReply(chatId: string) {
    const t = useThreadsStore.getState().threads[chatId];
    if (!t) return;
    const text = t.draft.trim();
    const attachments = useDraftStore.getState().attachments;
    if (text === '' && attachments.length === 0) return;

    /* queue the message if the assistant is currently generating */
    if (t.streaming) {
      const queued: QueuedMessage = {
        id: uid(),
        content: text,
        attachments,
        payload: payloadFor(chatId, text, attachments, null),
        createdAt: Date.now(),
      };
      patchThread(chatId, {
        queue: [...t.queue, queued],
        draft: '',
      });
      /* the queued message owns the staged attachments, so clear them right away */
      setDraft({ attachments: [] });
      return;
    }

    /* the leaf can be a failed unsent turn; the new one follows the last stored reply instead */
    const parentId =
      branchPath(t.messages, t.leafId).findLast((m) => m.role === 'assistant')
        ?.id ?? null;
    const msg: Msg = {
      id: uid(),
      parentId,
      role: 'user',
      content: text,
      attachments,
      createdAt: Date.now(),
      status: 'sending',
    };
    putThread(chatId, {
      ...t,
      /* a failed turn it replaces would otherwise linger as a phantom branch */
      messages: [
        ...t.messages.filter(
          (m) => !(m.status === 'failed' && m.parentId === parentId),
        ),
        msg,
      ],
      leafId: msg.id,
      draft: '',
    });
    sendMessage(chatId, payloadFor(chatId, text, attachments, parentId), dev())
      .then((res) => {
        setDraft({ attachments: [] });
        applySent(chatId, msg.id, res);
      })
      .catch((e: unknown) => {
        setMsgStatus(chatId, msg.id, 'failed');
        uiActions.toast(
          `Send failed — ${e instanceof Error ? e.message : 'error'}`,
          'error',
        );
      });
  },

  /** removes a queued message by id */
  dequeueMessage(chatId: string, queuedId: string) {
    const t = useThreadsStore.getState().threads[chatId];
    if (!t) return;
    patchThread(chatId, {
      queue: t.queue.filter((q) => q.id !== queuedId),
    });
  },

  /** sends an edited copy of user turn `msgId` as its sibling, starting a new branch there */
  editAndResend(chatId: string, msgId: string, content: string) {
    const t = useThreadsStore.getState().threads[chatId];
    const orig = t?.messages.find((m) => m.id === msgId);
    if (!t || t.streaming || orig?.role !== 'user') return;
    const text = content.trim();
    if (text === '' && orig.attachments.length === 0) return;
    const msg: Msg = {
      id: uid(),
      parentId: orig.parentId,
      role: 'user',
      content: text,
      attachments: orig.attachments,
      createdAt: Date.now(),
      status: 'sending',
    };
    putThread(chatId, { ...t, messages: [...t.messages, msg], leafId: msg.id });
    sendMessage(
      chatId,
      payloadFor(chatId, text, orig.attachments, orig.parentId),
      dev(),
    )
      .then((res) => applySent(chatId, msg.id, res))
      .catch((e: unknown) => {
        setMsgStatus(chatId, msg.id, 'failed');
        uiActions.toast(`Edit failed — ${errorText(e)}`, 'error');
      });
  },

  /** answers reply `msgId`'s user turn again with the selected model, as a sibling branch */
  regenerate(chatId: string, msgId: string) {
    const d = useDraftStore.getState();
    /* the composer's model is empty until a chat's thread names one (see clearChatModel) */
    const replyModelId = useThreadsStore
      .getState()
      .threads[chatId]?.messages.find((x) => x.id === msgId)?.modelId;
    rememberActiveTools(chatId);
    startBranch(chatId, 'regenerate', () =>
      regenerateMessage(msgId, {
        /* a chat page with no model picked yet answers with the model of the reply it re-runs */
        modelId: knownModelId(d.modelId)
          ? d.modelId
          : (replyModelId ?? d.modelId),
        toolGrants: effectiveGrants(),
        toolProviders: d.toolProviders,
      }),
    );
  },

  /** reruns failed call `callId` of reply `msgId` and lets the model continue, as a sibling branch */
  retryToolCall(chatId: string, msgId: string, callId: string) {
    const d = useDraftStore.getState();
    const m = useThreadsStore
      .getState()
      .threads[chatId]?.messages.find((x) => x.id === msgId);
    rememberActiveTools(chatId);
    startBranch(chatId, 'retry', () =>
      retryToolCall(msgId, callId, {
        /* the reply is continued mid-way, so it stays with the model that started it */
        modelId: knownModelId(m?.modelId) ? m.modelId : d.modelId,
        toolGrants: effectiveGrants(),
        toolProviders: d.toolProviders,
      }),
    );
  },

  /** sends the next queued message for a chat after the stream finishes */
  drainQueue(chatId: string) {
    const t = useThreadsStore.getState().threads[chatId];
    if (!t || t.queue.length === 0 || t.streaming) return;
    const next = t.queue[0];
    if (!next) return;
    const rest = t.queue.slice(1);
    /* resolve parentId at send time so it follows the latest assistant reply */
    const parentId =
      branchPath(t.messages, t.leafId).findLast((m) => m.role === 'assistant')
        ?.id ?? null;
    const payload: OutgoingMessage = { ...next.payload, parentId };
    const msg: Msg = {
      id: uid(),
      parentId,
      role: 'user',
      content: next.content,
      attachments: next.attachments as Msg['attachments'],
      createdAt: next.createdAt,
      status: 'sending',
    };
    putThread(chatId, {
      ...t,
      messages: [...t.messages, msg],
      leafId: msg.id,
      queue: rest,
    });
    sendMessage(chatId, payload, dev())
      .then((res) => applySent(chatId, msg.id, res))
      .catch((e: unknown) => {
        setMsgStatus(chatId, msg.id, 'failed');
        uiActions.toast(
          `Queued send failed — ${e instanceof Error ? e.message : 'error'}`,
          'error',
        );
      });
  },

  flushQueue() {
    const q = useNetworkStore.getState().queued;
    if (q.length === 0) return;
    uiActions.toast('Reconnected — sending queued messages');
    for (const item of q) {
      sendMessage(item.chatId, item.payload, dev())
        .then((res) => applySent(item.chatId, item.msgId, res))
        .catch(() => setMsgStatus(item.chatId, item.msgId, 'failed'));
    }
    useNetworkStore.setState({ queued: [] });
  },
};

onStreamSettled((chatId) => sendActions.drainQueue(chatId));
