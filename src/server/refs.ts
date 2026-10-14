/*
 * server/refs — resolves the cross-entity bodies behind a turn's
 * note/memory/chat attachments.
 *
 * Business logic:
 * - a note, memory or chat attachment stores only a reference (noteId,
 *   memoryId, chatId); the actual text is inlined at generation time so
 *   a later edit to the source is what the model sees.
 * - collectRefs() gathers all three maps in one pass for a path of
 *   messages, scoping every fetch to the user's own rows: a foreign or
 *   deleted id reads as absent and the block is dropped rather than
 *   failing the send.
 * - memories inline as key/value facts; chats inline their visible
 *   branch's transcript (root→leaf, user/assistant turns), matching how
 *   notes inline their title+text.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import type { MessageRow } from '../db/schema';
import { chats, memories, messages } from '../db/schema';
import { isUuid } from './chats';
import type { ChatTexts, MemoryTexts, Refs } from './runs';
import { attachedNotes } from './notes';

const refIds = (
  msgs: Pick<MessageRow, 'attachments'>[],
  kind: string,
): string[] => [
  ...new Set(
    msgs.flatMap((m) =>
      ((m.attachments as unknown[]) ?? []).flatMap((a) => {
        const at = a as { kind?: string; noteId?: string; memoryId?: string; chatId?: string };
        if (at.kind !== kind) return [];
        const id =
          kind === 'note' ? at.noteId : kind === 'memory' ? at.memoryId : at.chatId;
        return id && isUuid(id) ? [id] : [];
      }),
    ),
  ),
];

/* memory facts by id; a deleted or foreign memory is simply absent */
export const attachedMemories = async (
  db: Db,
  userId: string,
  msgs: Pick<MessageRow, 'attachments'>[],
): Promise<MemoryTexts> => {
  const ids = refIds(msgs, 'memory');
  if (ids.length === 0) return new Map();
  const found = await db
    .select()
    .from(memories)
    .where(and(inArray(memories.id, ids), eq(memories.userId, userId)));
  return new Map(found.map((m) => [m.id, { key: m.key, value: m.value }]));
};

/* other chats by id, inlined as their visible branch's transcript */
export const attachedChats = async (
  db: Db,
  userId: string,
  msgs: Pick<MessageRow, 'attachments'>[],
): Promise<ChatTexts> => {
  const ids = refIds(msgs, 'chat');
  if (ids.length === 0) return new Map();
  const found = await db
    .select()
    .from(chats)
    .where(and(inArray(chats.id, ids), eq(chats.userId, userId)));
  const out = new Map<string, { title: string; turns: { role: 'user' | 'assistant'; content: string }[] }>();
  if (found.length === 0) return out;
  /* transcripts follow the chat's current leaf, so each id resolves once */
  for (const c of found) {
    const all = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, c.id));
    const byId = new Map(all.map((m) => [m.id, m]));
    const path: MessageRow[] = [];
    for (
      let m = c.leafId ? byId.get(c.leafId) : undefined;
      m && path.length < all.length;
      m = m.parentId ? byId.get(m.parentId) : undefined
    )
      path.push(m);
    path.reverse();
    out.set(c.id, {
      title: c.title,
      turns: path
        .filter((m) => m.content !== '')
        .map((m) => ({ role: m.role, content: m.content })),
    });
  }
  return out as ChatTexts;
};

/* the full reference set behind a path of turns, gathered for inlining */
export const collectRefs = async (
  db: Db,
  userId: string,
  msgs: Pick<MessageRow, 'attachments'>[],
): Promise<Refs> => ({
  notes: await attachedNotes(db, userId, msgs),
  memories: await attachedMemories(db, userId, msgs),
  chats: await attachedChats(db, userId, msgs),
});
