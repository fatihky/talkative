/*
 * message-tree — the branching arithmetic shared by the client thread store
 * and the server message routes, so both sides agree on what a delete takes.
 *
 * Business logic:
 * - Pure helpers over anything shaped {id, parentId, role}; no store or db
 *   access. Consumers are stores/threads, the message bubble's delete
 *   confirm (it shows the removal count), and DELETE /api/messages/:id.
 * - removalSet returns the message plus its whole subtree, grown by
 *   repeated passes until nothing new joins, so the input's order — and a
 *   subtree stored out of order — doesn't matter.
 * - Deleting an assistant reply whose user turn has no other child pulls
 *   that turn in as well and makes it `root`: nothing could answer it
 *   afterwards. The route uses root.parentId to land the chat when no
 *   sibling survives.
 * - newestLeaf follows the last child down from an id to its branch tip,
 *   which is how the delete route moves the leaf onto the newest surviving
 *   sibling; the walk is bounded by messages.length against a cycle.
 * - countLeaves counts the messages nothing hangs off — one per branch —
 *   and is how chats.branch_count is recomputed after a delete (floored
 *   at 1).
 */

type Node = {
  id: string;
  parentId?: string | null | undefined;
  role: 'user' | 'assistant';
};

/**
 * what deleting message `id` takes with it: the message and everything below it. a user
 * turn whose only reply goes is removed too, since nothing could answer it afterwards.
 * `root` is the topmost removed message.
 */
export const removalSet = <T extends Node>(
  messages: T[],
  id: string,
): { ids: Set<string>; root: T | undefined } => {
  const target = messages.find((m) => m.id === id);
  if (!target) return { ids: new Set(), root: undefined };
  const parent = target.parentId
    ? messages.find((m) => m.id === target.parentId)
    : undefined;
  const root =
    target.role === 'assistant' &&
    parent?.role === 'user' &&
    !messages.some((m) => m.parentId === parent.id && m.id !== target.id)
      ? parent
      : target;
  const ids = new Set([root.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of messages)
      if (m.parentId && ids.has(m.parentId) && !ids.has(m.id)) {
        ids.add(m.id);
        grew = true;
      }
  }
  return { ids, root };
};

/** follows the newest child down from `id` to the tip of that branch */
export const newestLeaf = <T extends Node>(messages: T[], id: string) => {
  let leaf = id;
  for (let i = 0; i < messages.length; i++) {
    const child = messages.findLast((m) => m.parentId === leaf);
    if (!child) break;
    leaf = child.id;
  }
  return leaf;
};

/** messages nothing hangs off, i.e. one per branch */
export const countLeaves = <T extends Node>(messages: T[]) => {
  const parents = new Set(messages.map((m) => m.parentId));
  return messages.filter((m) => !parents.has(m.id)).length;
};
