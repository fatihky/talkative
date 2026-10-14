/*
 * tools/todo — a scratch to-do list the model keeps for the current chat
 * while working through a task.
 *
 * Business logic:
 * - every query is scoped to (userId, chatId): the list is per-chat
 *   disposable working memory — durable cross-chat facts belong to the
 *   memory tool — and deleting the chat cascades the rows away.
 * - list orders pending items first, then by creation time, rendered as
 *   `- [ ]/[x] title` lines with the optional note beneath; a status arg
 *   filters to pending or done.
 * - add returns the new row's uuid in its confirmation — the only handle
 *   the model gets — and complete/update/delete throw `no todo with id …`
 *   for unknown ids or ids from another chat.
 * - update patches only the fields present (title, note — including
 *   clearing it — and status:'pending' reopens a done item) and throws when
 *   nothing would change.
 * - clear resets every todo of the chat to pending without deleting;
 *   delete is the only action that removes a row.
 * - writes hit the DB immediately and persist across replies in the same
 *   chat, but nothing renders them in the ui — the list exists purely for
 *   the model.
 * - keyless 'default' backend: always available when granted (on by
 *   default).
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../db';
import { todos } from '../../db/schema';
import type { ServerTool } from './index';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const describe = (t: typeof todos.$inferSelect): string => {
  const mark = t.done ? 'x' : ' ';
  const parts = [`- [${mark}] ${t.title}`];
  if (t.note) parts.push(`  _${t.note}_`);
  return parts.join('\n');
};

export const todo: ServerTool = {
  id: 'todo',
  description:
    'Track a scratch to-do list for the current chat while working on a task. ' +
    'Use it to keep an ordered plan of sub-steps the user asked for, marking items done ' +
    'as you complete them. Actions: list, add, complete, update (rename title/note or reopen), ' +
    'clear (mark all pending items back to pending), and rename. The list is scoped to this ' +
    'chat only and is disposable working memory, not a durable task manager.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'complete', 'update', 'delete', 'clear'],
      },
      id: {
        type: 'string',
        description:
          'the todo id from list; required for complete, update and delete',
      },
      title: {
        type: 'string',
        description: 'the task; required for add, optional for update',
      },
      note: {
        type: 'string',
        description: 'optional detail; add or update',
      },
      status: {
        type: 'string',
        enum: ['pending', 'done', 'all'],
        description: 'list filter; default all',
      },
    },
    required: ['action'],
  },
  backends: () => [{ id: 'default' }],
  async run(args, ctx) {
    const db = getDb();
    const mine = and(
      eq(todos.userId, ctx.userId),
      eq(todos.chatId, ctx.chatId),
    );
    const byId = and(mine, eq(todos.id, str(args.id)));

    switch (args.action) {
      case 'list': {
        const status = str(args.status);
        const rows = await db
          .select()
          .from(todos)
          .where(
            and(
              mine,
              status === 'pending'
                ? eq(todos.done, false)
                : status === 'done'
                  ? eq(todos.done, true)
                  : undefined,
            ),
          )
          .orderBy(asc(todos.done), asc(todos.createdAt));
        if (!rows.length) return 'no todos for this chat yet';
        return rows.map(describe).join('\n');
      }
      case 'add': {
        const title = str(args.title);
        if (!title) throw new Error('add needs a title');
        const insert = await db
          .insert(todos)
          .values({
            userId: ctx.userId,
            chatId: ctx.chatId,
            title,
            note: str(args.note) || null,
          })
          .returning();
        return `added todo "${title}" (id ${insert[0]!.id})`;
      }
      case 'complete': {
        const id = str(args.id);
        if (!id) throw new Error('complete needs an id');
        const result = await db
          .update(todos)
          .set({ done: true })
          .where(byId)
          .returning({ id: todos.id });
        if (!result.length) throw new Error(`no todo with id "${id}"`);
        return `completed todo "${id}"`;
      }
      case 'update': {
        const id = str(args.id);
        if (!id) throw new Error('update needs an id');
        const set: Record<string, unknown> = {};
        const title = str(args.title);
        if (title) set.title = title;
        if ('note' in args) set.note = str(args.note) || null;
        if (args.action === 'update' && str(args.status) === 'pending')
          set.done = false;
        if (!Object.keys(set).length)
          throw new Error('update needs at least one field to change');
        const result = await db
          .update(todos)
          .set(set)
          .where(byId)
          .returning({ id: todos.id });
        if (!result.length) throw new Error(`no todo with id "${id}"`);
        return `updated todo "${id}"`;
      }
      case 'delete': {
        const id = str(args.id);
        if (!id) throw new Error('delete needs an id');
        const result = await db
          .delete(todos)
          .where(byId)
          .returning({ id: todos.id });
        if (!result.length) throw new Error(`no todo with id "${id}"`);
        return `deleted todo "${id}"`;
      }
      case 'clear': {
        await db.update(todos).set({ done: false }).where(mine);
        return 'reset this chat\'s todos to pending';
      }
      default:
        throw new Error(
          'action must be list, add, complete, update, delete or clear',
        );
    }
  },
};
