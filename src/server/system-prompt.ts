/*
 * SystemPrompt — the effective system turn for a chat run, assembled
 * from its folder chain and its own prompt.
 *
 * Business logic:
 * - order is broad → specific: every ancestor folder's prompt from
 *   the outermost in, then the chat's own last; the walk goes
 *   child→parent but unshifts, so parents end up ahead.
 * - one query loads all of the user's folders and the parent walk
 *   happens in memory; the loop is capped at the folder count so a
 *   corrupt parentId cycle can't spin forever.
 * - blank/whitespace-only prompts are skipped at every level, and
 *   when nothing remains no system turn is emitted at all — senders
 *   prepend the result only when non-empty.
 * - computed per run, never stored: send, regenerate and mid-reply
 *   retry each rebuild it, so a folder or chat prompt edit applies
 *   to the next generation immediately.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import type { ChatRow } from '../db/schema';
import { folders } from '../db/schema';
import type { Turn } from './runs';

/**
 * a chat's effective system prompt: every folder's from the outermost in, then the
 * chat's own, so broad instructions come first and the most specific ones last
 */
export const systemTurns = async (
  db: Db,
  chat: Pick<ChatRow, 'userId' | 'folderId' | 'systemPrompt'>,
): Promise<Turn[]> => {
  const parts: string[] = [];
  if (chat.folderId) {
    const all = await db
      .select({
        id: folders.id,
        parentId: folders.parentId,
        systemPrompt: folders.systemPrompt,
      })
      .from(folders)
      .where(eq(folders.userId, chat.userId));
    const byId = new Map(all.map((f) => [f.id, f]));
    /* the size guard stops a corrupt cycle from spinning forever */
    for (
      let f = byId.get(chat.folderId), n = 0;
      f && n <= all.length;
      f = f.parentId ? byId.get(f.parentId) : undefined, n++
    )
      if (f.systemPrompt?.trim()) parts.unshift(f.systemPrompt.trim());
  }
  if (chat.systemPrompt?.trim()) parts.push(chat.systemPrompt.trim());
  return parts.length > 0
    ? [{ role: 'system', content: parts.join('\n\n') }]
    : [];
};