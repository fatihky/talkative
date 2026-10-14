/*
 * tools/memory — the user's durable cross-chat memory as key → value
 * facts.
 *
 * Business logic:
 * - save/list/delete on the memories table, every query scoped to
 *   ctx.userId; the unique (userId, key) index keeps one fact per key.
 * - save is an upsert — an existing key gets the new value, otherwise a row
 *   is inserted — so updating a fact is the same call as creating it, and
 *   both key and value are required.
 * - list returns all rows newest-first as `key: value` lines ('no memories
 *   saved' when empty); nothing is injected into the prompt automatically,
 *   so the model only ever sees memories by calling list — which the tool
 *   description tells it to do before answering questions that may depend
 *   on them.
 * - delete distinguishes a removal (`deleted "<key>"`) from a no-op (`no
 *   memory named "<key>"`) so the model can tell them apart.
 * - writes outlive the chat and the run — this is the durable side-effect
 *   tool, unlike the chat-scoped todo tool — and the same rows are managed
 *   by the user under settings → memories.
 * - keyless 'default' backend: always available when granted (on by
 *   default).
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db';
import { memories } from '../../db/schema';
import type { ServerTool } from './index';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export const memory: ServerTool = {
  id: 'memory',
  description:
    'Persistent memory shared across all chats. Save durable facts about the user or their projects ' +
    '(preferences, names, decisions), list what is saved, or delete outdated entries. ' +
    'List memories before answering questions that may depend on them.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'list', 'delete'] },
      key: {
        type: 'string',
        description:
          'short identifier, e.g. "preferred-language"; required for save and delete',
      },
      value: {
        type: 'string',
        description: 'the fact to remember; required for save',
      },
    },
    required: ['action'],
  },
  backends: () => [{ id: 'default' }],
  async run(args, ctx) {
    const db = getDb();
    const key = str(args.key);
    const mine = eq(memories.userId, ctx.userId);
    const byKey = and(mine, eq(memories.key, key));
    switch (args.action) {
      case 'list': {
        const rows = await db
          .select()
          .from(memories)
          .where(mine)
          .orderBy(desc(memories.updatedAt));
        return rows.length
          ? rows.map((m) => `${m.key}: ${m.value}`).join('\n')
          : 'no memories saved';
      }
      case 'save': {
        const value = str(args.value);
        if (!key || !value) throw new Error('save needs key and value');
        const existing = await db
          .select()
          .from(memories)
          .where(byKey)
          .then((rows) => rows[0] ?? null);
        if (existing) {
          await db.update(memories).set({ value }).where(byKey);
        } else {
          await db.insert(memories).values({ userId: ctx.userId, key, value });
        }
        return `saved "${key}"`;
      }
      case 'delete': {
        if (!key) throw new Error('delete needs key');
        const result = await db
          .delete(memories)
          .where(byKey)
          .returning({ id: memories.id });
        return result.length ? `deleted "${key}"` : `no memory named "${key}"`;
      }
      default:
        throw new Error('action must be save, list or delete');
    }
  },
};
