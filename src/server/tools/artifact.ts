/*
 * tools/artifact — create and revise the side-panel documents; every
 * version is stored in the tool call itself.
 *
 * Business logic:
 * - artifacts have no table: each successful call returns the whole
 *   snapshot as `raw`, which is saved with the message's tool calls, and
 *   the panel rebuilds the artifacts from the calls along the branch being
 *   viewed — versioning is per-branch by construction.
 * - the in-flight state lives in a WeakMap keyed by the run's abort signal,
 *   so it lives exactly as long as the run; it is seeded from the branch up
 *   to this reply plus the calls this reply already made, since a retry
 *   starts mid-reply and carries those over.
 * - calls are applied one at a time through a per-run queue: parallel edits
 *   to the same artifact would otherwise both start from the same version
 *   and silently lose one.
 * - create needs a title, a known kind (code/markdown/html/svg/mermaid) and
 *   non-empty content, and refuses an id that exists; revisions must go
 *   through update (full rewrite, optional rename) or edit (exact
 *   find/replace), each bumping the version along the branch.
 * - edit's find text must occur exactly once — zero or multiple occurrences
 *   throw with guidance to view the artifact or add context; view without
 *   an id lists the chat's artifacts, with an id returns the full content.
 * - model-chosen ids are slugified (lowercase, dashes, ≤64 chars) to stay
 *   usable as file names, and content is capped at ARTIFACT_MAX (1M chars)
 *   because raw is capped at RAW_MAX and json escaping can double the size.
 * - the model only sees a short confirmation ("created artifact … (vN); it
 *   is shown to the user in the artifact panel"), never the content back.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../db';
import { messages } from '../../db/schema';
import {
  ARTIFACT_KINDS,
  ARTIFACT_MAX,
  type ArtifactKind,
  type ArtifactSnapshot,
  callSnapshot,
  collectArtifacts,
} from '../../lib/artifacts';
import { branchPath } from '../chats';
import type { ServerTool, ToolContext, ToolOutput } from './index';

type State = Map<string, ArtifactSnapshot>;

/*
 * the artifacts as this run sees them, keyed by its abort signal so the state lives
 * exactly as long as the run. calls are applied one at a time: parallel edits to the same
 * artifact would otherwise both start from the same version.
 */
const runs = new WeakMap<
  AbortSignal,
  { state: Promise<State>; queue: Promise<unknown> }
>();

/* the branch up to this reply, plus what this reply already wrote (a retry starts mid-reply) */
const load = async (ctx: ToolContext): Promise<State> => {
  const db = getDb();
  const msg = await db
    .select()
    .from(messages)
    .where(eq(messages.id, ctx.messageId))
    .then((rows) => rows[0] ?? null);
  const path = msg
    ? await branchPath(db, msg.chatId, msg.parentId ?? null)
    : [];
  const state: State = new Map();
  for (const a of collectArtifacts(
    path as unknown as readonly {
      id: string;
      toolCalls?: import('../../types').ToolCall[];
    }[],
  )) {
    const last = a.versions.at(-1);
    if (last) state.set(a.id, last);
  }
  for (const c of ctx.calls()) {
    const s = callSnapshot(c);
    const prev = s && state.get(s.id);
    if (s && (!prev || s.version > prev.version)) state.set(s.id, s);
  }
  return state;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/* model-chosen ids are loose; keep them usable as file names */
const slug = (v: unknown) =>
  str(v)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

const occurrences = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

const checkSize = (content: string) => {
  if (content.length > ARTIFACT_MAX)
    throw new Error(
      `content is ${content.length} characters; artifacts are capped at ${ARTIFACT_MAX}`,
    );
};

const saved = (
  state: State,
  next: ArtifactSnapshot,
  verb: string,
): ToolOutput => {
  state.set(next.id, next);
  return {
    result: `${verb} artifact "${next.id}" (v${next.version}); it is shown to the user in the artifact panel`,
    raw: JSON.stringify(next),
  };
};

const apply = (state: State, args: Record<string, unknown>): ToolOutput => {
  const id = slug(args.id);
  const action = args.action;
  if (action === 'view') {
    if (!id) {
      if (state.size === 0) return 'no artifacts in this chat yet';
      return [...state.values()]
        .map(
          (a) =>
            `${a.id}: ${a.title} (${a.kind}${a.language ? `, ${a.language}` : ''}, v${a.version}, ${a.content.length} chars)`,
        )
        .join('\n');
    }
    const a = state.get(id);
    if (!a) throw new Error(`no artifact named "${id}"`);
    return `${a.title} (v${a.version})\n\n${a.content}`;
  }
  if (!id) throw new Error('id is required');
  const prev = state.get(id);
  switch (action) {
    case 'create': {
      if (prev)
        throw new Error(
          `artifact "${id}" already exists; use update or edit to change it`,
        );
      const title = str(args.title).trim();
      const kind = args.kind as ArtifactKind;
      const content = str(args.content);
      if (!title) throw new Error('create needs a title');
      if (!ARTIFACT_KINDS.includes(kind))
        throw new Error(`kind must be one of ${ARTIFACT_KINDS.join(', ')}`);
      if (!content.trim()) throw new Error('create needs content');
      checkSize(content);
      const language = kind === 'code' ? str(args.language).trim() : '';
      return saved(
        state,
        {
          id,
          title,
          kind,
          ...(language ? { language } : {}),
          content,
          version: 1,
        },
        'created',
      );
    }
    case 'update': {
      if (!prev) throw new Error(`no artifact named "${id}"; create it first`);
      const content = str(args.content);
      if (!content.trim()) throw new Error('update needs the full new content');
      checkSize(content);
      const title = str(args.title).trim();
      return saved(
        state,
        {
          ...prev,
          ...(title ? { title } : {}),
          content,
          version: prev.version + 1,
        },
        'updated',
      );
    }
    case 'edit': {
      if (!prev) throw new Error(`no artifact named "${id}"; create it first`);
      const find = str(args.find);
      const replace = str(args.replace);
      if (!find) throw new Error('edit needs find');
      const n = occurrences(prev.content, find);
      if (n === 0)
        throw new Error(
          `find text not found in "${id}"; view the artifact to see its current content`,
        );
      if (n > 1)
        throw new Error(
          `find text occurs ${n} times in "${id}"; include more surrounding text so it matches once`,
        );
      const content = prev.content.replace(find, () => replace);
      checkSize(content);
      return saved(
        state,
        { ...prev, content, version: prev.version + 1 },
        'edited',
      );
    }
    default:
      throw new Error('action must be create, update, edit or view');
  }
};

export const artifact: ServerTool = {
  id: 'artifact',
  description:
    'Create and revise artifacts: standalone content the user sees in a side panel next to the chat, ' +
    'with every version kept. Use it for substantial, self-contained output the user will reuse or ' +
    'iterate on, such as a program or file (kind "code" with a language), a document or report ' +
    '("markdown"), a web page or interactive demo ("html", a complete document; it renders in a ' +
    'sandboxed iframe, so inline all css and js or load them from a CDN), a diagram (' +
    '"mermaid", Mermaid.js syntax; renders as an interactive diagram preview), or a graphic ("svg"). ' +
    'Do not use it for short snippets or conversational answers. ' +
    'To change an artifact, prefer "edit" (replace one exact, unique piece of text) for small ' +
    'changes and "update" (full new content) for rewrites; keep the same id so it becomes a new ' +
    'version. "view" without an id lists the artifacts in this chat; with an id it returns the ' +
    'current content. Do not repeat the artifact content in your reply; the user can already see it.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'edit', 'view'],
      },
      id: {
        type: 'string',
        description:
          'short kebab-case identifier, e.g. "todo-app"; required except for view without an id',
      },
      title: {
        type: 'string',
        description:
          'human-readable title; required for create, optional rename for update',
      },
      kind: {
        type: 'string',
        enum: [...ARTIFACT_KINDS],
        description: 'required for create',
      },
      language: {
        type: 'string',
        description: 'kind "code" only: language name, e.g. "python"',
      },
      content: {
        type: 'string',
        description: 'the complete content; required for create and update',
      },
      find: {
        type: 'string',
        description:
          'edit only: exact text to replace; must occur exactly once',
      },
      replace: {
        type: 'string',
        description: 'edit only: the replacement text',
      },
    },
    required: ['action'],
  },
  backends: () => [{ id: 'default' }],
  run(args, ctx) {
    let entry = runs.get(ctx.signal);
    if (!entry) {
      entry = { state: load(ctx), queue: Promise.resolve() };
      runs.set(ctx.signal, entry);
    }
    const { state } = entry;
    const job = entry.queue.then(async () => apply(await state, args));
    entry.queue = job.catch(() => undefined);
    return job;
  },
};
